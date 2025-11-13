import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  collection,
  query,
  onSnapshot,
  Timestamp,
  writeBatch,
  getDocs,
} from 'firebase/firestore';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

// --- Firebase Initialization ---
// IMPORTANT: DO NOT hardcode your config here.
// These keys are automatically provided by Vercel from Environment Variables
const firebaseConfig = {
  apiKey: process.env.REACT_APP_API_KEY,
  authDomain: process.env.REACT_APP_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_PROJECT_ID,
  storageBucket: process.env.REACT_APP_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_APP_ID,
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Get App ID - Vercel will not have __app_id defined
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // eslint-disable-line no-undef

// --- Firestore Path Helpers ---
// Gets the path for a user's private task collection
const getTasksCollectionPath = (userId) =>
  `/artifacts/${appId}/users/${userId}/tasks`;

// Gets the path for a user's public statistics document
const getPublicStatsDocPath = (userId) =>
  `/artifacts/${appId}/public/data/userStats/${userId}`;

// Gets the path for the collection of all public stats (for charts)
const getAllPublicStatsCollectionPath = () =>
  `/artifacts/${appId}/public/data/userStats`;

// --- Audio Context for Bell ---
// Create a persistent audio context
let audioContext;
try {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
} catch (e) {
  console.error('Web Audio API is not supported in this browser');
}

// Function to play a "beep" sound
const playBell = () => {
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // A nice "beep"
  gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(
    0.001,
    audioContext.currentTime + 0.5
  );
  oscillator.start(audioContext.currentTime);
  oscillator.stop(audioContext.currentTime + 0.5);
};

// --- Main App Component ---
export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // --- App State ---
  const [tasks, setTasks] = useState([]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskStartTime, setNewTaskStartTime] = useState('');
  const [newTaskHours, setNewTaskHours] = useState(1);
  const [allUserStats, setAllUserStats] = useState([]);
  const [filterType, setFilterType] = useState('today');
  const [dailyPushups, setDailyPushups] = useState(5);
  const [runningTimers, setRunningTimers] = useState({}); // { taskId: { intervalId, elapsedSeconds } }
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetError, setResetError] = useState(null);

  // --- Live Clock State ---
  const [currentTime, setCurrentTime] = useState(new Date());

  // --- Authentication Effect ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        // Check if this is a new user
        const userStatsRef = doc(db, getPublicStatsDocPath(currentUser.uid));
        const userStatsSnap = await getDoc(userStatsRef);

        if (!userStatsSnap.exists()) {
          // New user: create their public stat document
          await setDoc(userStatsRef, {
            userId: currentUser.uid,
            displayName: currentUser.displayName,
            email: currentUser.email,
            tasksCompleted: 0,
            totalHours: 0,
            pushupsCompleted: 0,
            lastReset: new Date(),
          });
        }
        setUser(currentUser);
      } else {
        setUser(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // --- Live Clock & Bell Effect ---
  useEffect(() => {
    // Start a timer to update the current time every second
    const clockInterval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    return () => clearInterval(clockInterval);
  }, []);

  // --- Firestore Listeners Effect ---
  useEffect(() => {
    if (!user) {
      setTasks([]);
      setAllUserStats([]);
      return;
    }

    // Listener for user's private tasks
    const tasksQuery = query(
      collection(db, getTasksCollectionPath(user.uid))
    );
    const unsubscribeTasks = onSnapshot(
      tasksQuery,
      (snapshot) => {
        const userTasks = snapshot.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));
        setTasks(userTasks);
      },
      (err) => {
        console.error('Error fetching tasks:', err);
        setError('Failed to load tasks.');
      }
    );

    // Listener for all public stats (for charts)
    const statsQuery = query(collection(db, getAllPublicStatsCollectionPath()));
    const unsubscribeStats = onSnapshot(
      statsQuery,
      (snapshot) => {
        const stats = snapshot.docs.map((d) => d.data());
        setAllUserStats(stats);
      },
      (err) => {
        console.error('Error fetching user stats:', err);
        setError('Failed to load user stats.');
      }
    );

    return () => {
      unsubscribeTasks();
      unsubscribeStats();
    };
  }, [user]);

  // --- Timer Management Effect ---
  useEffect(() => {
    // This effect cleans up intervals when a task is completed or deleted
    return () => {
      Object.values(runningTimers).forEach((timer) => {
        clearInterval(timer.intervalId);
      });
    };
  }, [runningTimers]);

  // --- Task Categorization & Bell Logic ---
  const categorizedTasks = useMemo(() => {
    if (!user)
      return { upcoming: [], active: [], completed: [], todayCompleted: [] };

    const now = currentTime.getTime();
    const startOfToday = new Date(currentTime);
    startOfToday.setHours(0, 0, 0, 0);

    const upcoming = [];
    const active = [];
    const completed = [];
    const todayCompleted = [];

    tasks.forEach((task) => {
      // Ensure startTime is a Date object
      const startTime = task.startTime?.toDate ? task.startTime.toDate() : null;
      if (!startTime) return;

      if (task.completed) {
        completed.push(task);
        const completedTime = task.completedAt?.toDate
          ? task.completedAt.toDate()
          : null;
        if (completedTime && completedTime >= startOfToday) {
          todayCompleted.push(task);
        }
      } else if (startTime.getTime() <= now) {
        // Active
        if (!task.notified) {
          playBell();
          // Mark as notified in Firestore so it only rings once
          const taskRef = doc(
            db,
            getTasksCollectionPath(user.uid),
            task.id
          );
          updateDoc(taskRef, { notified: true });
        }
        active.push(task);
      } else {
        // Upcoming
        upcoming.push(task);
      }
    });

    return { upcoming, active, completed, todayCompleted };
  }, [tasks, user, currentTime]);

  // --- Chart Data Filtering ---
  const filteredStats = useMemo(() => {
    if (allUserStats.length === 0) return [];

    const now = new Date();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - startOfToday.getDay());
    const startOfMonth = new Date(startOfToday);
    startOfMonth.setDate(1);

    return allUserStats.map((stat) => {
      // Find the user's tasks to filter by date
      const userTasks =
        stat.userId === user?.uid
          ? tasks
          : []; // Note: We can only filter the current user's tasks accurately by date

      // Helper to filter tasks for the current period
      const getTasksForPeriod = (periodStart) => {
        return userTasks.filter((task) => {
          const completedTime = task.completedAt?.toDate
            ? task.completedAt.toDate()
            : null;
          return (
            task.completed && completedTime && completedTime >= periodStart
          );
        });
      };

      let tasksForPeriod = [];
      if (filterType === 'today') {
        tasksForPeriod = getTasksForPeriod(startOfToday);
      } else if (filterType === 'week') {
        tasksForPeriod = getTasksForPeriod(startOfWeek);
      } else if (filterType === 'month') {
        tasksForPeriod = getTasksForPeriod(startOfMonth);
      } else {
        // 'all' - use the total stats, or filter by lastReset
        const lastReset = stat.lastReset?.toDate ? stat.lastReset.toDate() : null;
        if (lastReset) {
          tasksForPeriod = userTasks.filter((task) => {
            const completedTime = task.completedAt?.toDate
              ? task.completedAt.toDate()
              : null;
            return (
              task.completed && completedTime && completedTime >= lastReset
            );
          });
        } else {
          // Fallback for older data without lastReset
           tasksForPeriod = userTasks.filter(task => task.completed);
        }
      }

      // For other users, we can't filter by date, so we show totals
      // This is a limitation of our data model, but is fine for this app
      if (stat.userId !== user?.uid) {
         if (filterType === 'all') {
           return stat; // Show total stats for 'all'
         }
         // For other filters, we can't know their date-filtered stats,
         // so we'll return 0 or just their name.
         // A better model would store stats by date, but that's much more complex.
         // For now, we'll just show totals for 'all' and hide them otherwise.
         if (filterType !== 'all') {
            return {
             ...stat,
             tasksCompleted: 0,
             totalHours: 0,
             pushupsCompleted: 0,
           };
         }
         return stat;
      }

      // For the current user, calculate stats from the filtered tasks
      const tasksCompleted = tasksForPeriod.length;
      const totalHours = tasksForPeriod.reduce(
        (sum, task) => sum + (task.estimatedHours || 0),
        0
      );
      // We assume pushups are linked to the 'lastReset' or 'all'
      const pushupsCompleted = (filterType === 'all' || !stat.lastReset)
        ? stat.pushupsCompleted
        : (new Date(stat.lastReset.toDate()) < startOfToday ? 0 : stat.pushupsCompleted);


      return {
        ...stat,
        tasksCompleted,
        totalHours,
        pushupsCompleted: (filterType === 'today') ? pushupsCompleted : stat.pushupsCompleted, // Only show today's pushups for 'today'
      };
    }).filter(stat => stat.tasksCompleted > 0 || stat.pushupsCompleted > 0 || filterType === 'all'); // Only show users with activity
  }, [allUserStats, filterType, user, tasks]);

  // --- Auth Functions ---
  const signIn = async () => {
    setError(null);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error('Sign-in error:', err);
      setError(`Failed to sign in. Error: ${err.message}`);
    }
  };

  const logOut = async () => {
    // Stop all running timers before logging out
    Object.values(runningTimers).forEach((timer) => {
      clearInterval(timer.intervalId);
    });
    setRunningTimers({});
    await signOut(auth);
  };

  // --- Task Functions ---
  const handleAddTask = async (e) => {
    e.preventDefault();
    if (!user || !newTaskTitle || !newTaskStartTime || !newTaskHours) {
      setError('Please fill out all fields.');
      return;
    }
    setError(null);

    // CRITICAL: Convert local datetime-local string to a UTC Timestamp
    // The input 'newTaskStartTime' is like "2025-11-13T17:30"
    // We create a Date object from this string, which JS interprets in the *local* timezone.
    // When we create a Timestamp from this Date, Firestore stores it correctly.
    try {
      const localDate = new Date(newTaskStartTime);
      if (isNaN(localDate.getTime())) {
        setError('Invalid date/time format.');
        return;
      }
      
      const startTimeAsTimestamp = Timestamp.fromDate(localDate);

      await addDoc(collection(db, getTasksCollectionPath(user.uid)), {
        title: newTaskTitle,
        startTime: startTimeAsTimestamp,
        estimatedHours: parseFloat(newTaskHours),
        completed: false,
        notified: false,
        elapsedSeconds: 0,
        timerStarted: false,
      });

      // Reset form
      setNewTaskTitle('');
      setNewTaskStartTime('');
      setNewTaskHours(1);
    } catch (err) {
      console.error('Error adding task:', err);
      setError(`Failed to add task: ${err.message}`);
    }
  };

  const startTaskTimer = (taskId) => {
    if (runningTimers[taskId]) return; // Already running

    const task = tasks.find((t) => t.id === taskId);
    const initialElapsed = task.elapsedSeconds || 0;

    const intervalId = setInterval(() => {
      setRunningTimers((prevTimers) => {
        const newElapsed = (prevTimers[taskId]?.elapsedSeconds || initialElapsed) + 1;
        return {
          ...prevTimers,
          [taskId]: {
            ...prevTimers[taskId],
            elapsedSeconds: newElapsed,
          },
        };
      });
    }, 1000);

    setRunningTimers((prev) => ({
      ...prev,
      [taskId]: { intervalId, elapsedSeconds: initialElapsed },
    }));

    // Mark task as started in Firestore
    const taskRef = doc(db, getTasksCollectionPath(user.uid), taskId);
    updateDoc(taskRef, { timerStarted: true });
  };

  const stopTaskTimer = (taskId) => {
    const timer = runningTimers[taskId];
    if (!timer) return;

    clearInterval(timer.intervalId);
    const finalElapsedSeconds = timer.elapsedSeconds;

    // Remove from running timers state
    setRunningTimers((prev) => {
      const { [taskId]: _, ...rest } = prev;
      return rest;
    });

    // Update Firestore with final elapsed time
    const taskRef = doc(db, getTasksCollectionPath(user.uid), taskId);
    updateDoc(taskRef, {
      elapsedSeconds: finalElapsedSeconds,
      timerStarted: false, // Mark as stopped
    });
  };

  const handleCompleteTask = async (taskId) => {
    if (!user) return;

    // Stop timer if it's running
    stopTaskTimer(taskId);

    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    const taskRef = doc(db, getTasksCollectionPath(user.uid), taskId);
    const statsRef = doc(db, getPublicStatsDocPath(user.uid));

    try {
      const statsDoc = await getDoc(statsRef);
      if (!statsDoc.exists()) {
        setError('User stats document not found.');
        return;
      }
      const currentStats = statsDoc.data();

      // Update both documents in a batch
      const batch = writeBatch(db);

      // 1. Update private task
      batch.update(taskRef, {
        completed: true,
        completedAt: Timestamp.now(),
        elapsedSeconds: runningTimers[taskId]?.elapsedSeconds || task.elapsedSeconds,
      });

      // 2. Update public stats
      batch.update(statsRef, {
        tasksCompleted: (currentStats.tasksCompleted || 0) + 1,
        totalHours:
          (currentStats.totalHours || 0) + (task.estimatedHours || 0),
      });

      await batch.commit();

      // Clear from running timers state if it was there
      setRunningTimers((prev) => {
        const { [taskId]: _, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      console.error('Error completing task:', err);
      setError(`Failed to complete task: ${err.message}`);
    }
  };

  // --- Pushup Functions ---
  const handleAddPenalty = async () => {
    if (!user) return;
    const newPushupCount = dailyPushups + 5;
    setDailyPushups(newPushupCount);

    // Store in public stats
    const statsRef = doc(db, getPublicStatsDocPath(user.uid));
    try {
      const statsDoc = await getDoc(statsRef);
      const currentPushups = statsDoc.data()?.pushupsCompleted || 0;
      await updateDoc(statsRef, {
        pushupsCompleted: currentPushups + 5,
      });
    } catch (err) {
      console.error('Error adding penalty:', err);
      setError(`Failed to add penalty: ${err.message}`);
    }
  };

  // --- Admin Functions ---
  const handleResetData = async () => {
    if (!user) return;
    setResetError(null);

    try {
      const batch = writeBatch(db);

      // 1. Delete all tasks in the user's private collection
      const tasksQuery = query(collection(db, getTasksCollectionPath(user.uid)));
      const tasksSnapshot = await getDocs(tasksQuery);
      tasksSnapshot.forEach((doc) => {
        batch.delete(doc.ref);
      });

      // 2. Reset the user's public stats document
      const statsRef = doc(db, getPublicStatsDocPath(user.uid));
      batch.update(statsRef, {
        tasksCompleted: 0,
        totalHours: 0,
        pushupsCompleted: 0,
        lastReset: Timestamp.now(),
      });

      // Commit the batch
      await batch.commit();

      // Reset local state
      setDailyPushups(5);
      setRunningTimers({});
      setShowResetConfirm(false);
    } catch (err) {
      console.error('Error resetting data:', err);
      // Check for the specific permissions error
      if (err.code === 'permission-denied' || err.code === 'failed-precondition') {
        setResetError('Failed to reset data. Error: Missing or insufficient permissions. Please update your Firestore security rules.');
      } else {
        setResetError(`Failed to reset data: ${err.message}`);
      }
    }
  };

  // --- Helper Functions ---
  // Formats seconds into HH:MM:SS
  const formatStopwatch = (totalSeconds) => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(
      2,
      '0'
    )}:${String(seconds).padStart(2, '0')}`;
  };

  // --- Render ---
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-900 text-white">
        Loading...
      </div>
    );
  }

  // --- Logged Out View ---
  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 p-8">
        <h1 className="text-4xl font-bold text-white mb-6">
          Welcome to Your Task Tracker
        </h1>
        <p className="text-xl text-gray-300 mb-8">
          Sign in to track your tasks and compare progress with friends.
        </p>
        <button
          onClick={signIn}
          className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-lg shadow-lg hover:bg-blue-700 transition-colors"
        >
          Sign in with Google
        </button>
        {error && <p className="text-red-400 mt-6">{error}</p>}
      </div>
    );
  }

  // --- Logged In View ---
  const { upcoming, active, todayCompleted } = categorizedTasks;
  const currentFormattedTime = useMemo(() => {
     return currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }, [currentTime]);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-4 md:p-8 font-inter">
      <div className="max-w-7xl mx-auto">
        {/* --- Header --- */}
        <header className="flex flex-col md:flex-row justify-between items-center mb-6 p-4 bg-gray-800 rounded-lg shadow-lg">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-white">
              Welcome, {user.displayName}
            </h1>
            <p className="text-sm text-gray-400">
              Your User ID: {user.uid}
            </p>
          </div>
           <div className="text-center md:text-right mt-4 md:mt-0">
            <div className="text-2xl font-semibold text-white">{currentFormattedTime}</div>
            <div className="text-sm text-gray-400">{currentTime.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
          </div>
          <button
            onClick={logOut}
            className="mt-4 md:mt-0 px-5 py-2 bg-red-600 text-white font-semibold rounded-lg shadow hover:bg-red-700 transition-colors"
          >
            Sign Out
          </button>
        </header>

        {/* --- Error Display --- */}
        {error && (
          <div className="bg-red-800 border border-red-600 text-red-100 px-4 py-3 rounded-lg relative mb-6 shadow-lg">
            <strong className="font-bold">Error: </strong>
            <span className="block sm:inline">{error}</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* --- Left Column: Add Task & Penalties --- */}
          <div className="lg:col-span-1 flex flex-col gap-6">
            {/* --- Add Task Form --- */}
            <div className="bg-gray-800 p-6 rounded-lg shadow-xl">
              <h2 className="text-2xl font-semibold text-white mb-4">
                Add a New Task
              </h2>
              <form onSubmit={handleAddTask} className="space-y-4">
                <div>
                  <label
                    htmlFor="taskTitle"
                    className="block text-sm font-medium text-gray-300 mb-1"
                  >
                    Task Title
                  </label>
                  <input
                    type="text"
                    id="taskTitle"
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                    placeholder="e.g., Read 1 chapter"
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label
                    htmlFor="startTime"
                    className="block text-sm font-medium text-gray-300 mb-1"
                  >
                    Start Time
                  </label>
                  <input
                    type="datetime-local"
                    id="startTime"
                    value={newTaskStartTime}
                    onChange={(e) => setNewTaskStartTime(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label
                    htmlFor="taskHours"
                    className="block text-sm font-medium text-gray-300 mb-1"
                  >
                    Estimated Hours
                  </label>
                  <input
                    type="number"
                    id="taskHours"
                    value={newTaskHours}
                    min="0.1"
                    step="0.1"
                    onChange={(e) => setNewTaskHours(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg shadow-lg hover:bg-blue-700 transition-colors"
                >
                  Add Task
                </button>
              </form>
            </div>

            {/* --- Daily Penalty --- */}
            <div className="bg-gray-800 p-6 rounded-lg shadow-xl">
              <h2 className="text-2xl font-semibold text-white mb-4">
                Daily Penalty
              </h2>
              <div className="flex items-center justify-between mb-4">
                <span className="text-lg text-gray-300">Total Pushups:</span>
                <span className="text-3xl font-bold text-blue-400">
                  {allUserStats.find((s) => s.userId === user.uid)
                    ?.pushupsCompleted || 0}
                </span>
              </div>
              <div className="flex items-center space-x-4 mb-4">
                <input
                  type="checkbox"
                  id="addPenalty"
                  onChange={handleAddPenalty}
                  className="h-6 w-6 bg-gray-700 border-gray-600 rounded text-blue-500 focus:ring-blue-500"
                />
                <label htmlFor="addPenalty" className="text-lg text-gray-300">
                  Add Penalty (+5 Pushups)
                </label>
              </div>
              <p className="text-sm text-gray-400">
                Check this box to add a 5 pushup penalty to your daily count.
              </p>
            </div>

            {/* --- Admin Reset (Conditional) --- */}
            {user.email === 'atharlatif200@gmail.com' && (
              <div className="bg-gray-800 p-6 rounded-lg shadow-xl border border-red-700">
                <h2 className="text-2xl font-semibold text-red-400 mb-4">
                  Admin Panel
                </h2>
                <button
                  onClick={() => setShowResetConfirm(true)}
                  className="w-full px-4 py-2 bg-red-700 text-white font-semibold rounded-lg shadow-lg hover:bg-red-800 transition-colors"
                >
                  Reset All My Data
                </button>
                {resetError && (
                  <p className="text-red-400 mt-4">{resetError}</p>
                )}
                {showResetConfirm && (
                  <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
                    <div className="bg-gray-800 p-6 rounded-lg shadow-2xl border border-gray-700">
                      <h3 className="text-xl font-bold text-white mb-4">
                        Are you sure?
                      </h3>
                      <p className="text-gray-300 mb-6">
                        This will delete ALL of your tasks and reset your
                        stats. This cannot be undone.
                      </p>
                      <div className="flex justify-end space-x-4">
                        <button
                          onClick={() => setShowResetConfirm(false)}
                          className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleResetData}
                          className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                        >
                          Yes, Reset All My Data
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* --- Right Column: Task Lists & Charts --- */}
          <div className="lg:col-span-2 flex flex-col gap-6">
            {/* --- Task Lists --- */}
            <div className="bg-gray-800 p-6 rounded-lg shadow-xl">
              <h2 className="text-2xl font-semibold text-white mb-4">
                Your Tasks for Today ({new Date().toLocaleDateString()})
              </h2>

              {/* Active Tasks */}
              <TaskSection
                title="Active"
                tasks={active}
                runningTimers={runningTimers}
                onStart={startTaskTimer}
                onStop={stopTaskTimer}
                onComplete={handleCompleteTask}
                formatStopwatch={formatStopwatch}
                accentColor="red"
              />

              {/* Upcoming Tasks */}
              <TaskSection
                title="Upcoming"
                tasks={upcoming}
                accentColor="yellow"
              />

              {/* Today's Completed Tasks */}
              <TaskSection
                title="Completed Today"
                tasks={todayCompleted}
                accentColor="green"
              />
            </div>

            {/* --- Charts --- */}
            <div className="bg-gray-800 p-6 rounded-lg shadow-xl">
              <div className="flex flex-col md:flex-row justify-between items-center mb-4">
                <h2 className="text-2xl font-semibold text-white mb-4 md:mb-0">
                  Productivity Comparison
                </h2>
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                  className="bg-gray-700 border border-gray-600 text-white rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="today">Today</option>
                  <option value="week">This Week</option>
                  <option value="month">This Month</option>
                  <option value="all">All Time</option>
                </select>
              </div>

              {/* Charts Container */}
              <div className="space-y-8 mt-8">
                <ChartComponent
                  title="Tasks Completed"
                  data={filteredStats}
                  dataKey="tasksCompleted"
                  fill="#8884d8"
                />
                <ChartComponent
                  title="Total Hours"
                  data={filteredStats}
                  dataKey="totalHours"
                  fill="#82ca9d"
                />
                <ChartComponent
                  title="Total Pushups"
                  data={filteredStats}
                  dataKey="pushupsCompleted"
                  fill="#ffc658"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Sub-Component: TaskSection ---
function TaskSection({
  title,
  tasks,
  accentColor,
  runningTimers,
  onStart,
  onStop,
  onComplete,
  formatStopwatch,
}) {
  const colors = {
    red: 'border-red-500',
    yellow: 'border-yellow-500',
    green: 'border-green-500',
  };
  const accentClass = colors[accentColor] || 'border-gray-500';

  return (
    <div className="mb-6">
      <h3
        className={`text-xl font-semibold text-white mb-3 pb-2 ${accentClass} border-b-2`}
      >
        {title} ({tasks.length})
      </h3>
      {tasks.length === 0 ? (
        <p className="text-gray-400 italic">No tasks in this category.</p>
      ) : (
        <ul className="space-y-3">
          {tasks.map((task) => {
            const timer = runningTimers[task.id];
            const elapsed = timer
              ? timer.elapsedSeconds
              : task.elapsedSeconds || 0;
            const isRunning = !!timer;

            return (
              <li
                key={task.id}
                className="flex flex-col md:flex-row items-start md:items-center justify-between p-4 bg-gray-700 rounded-lg shadow"
              >
                <div className="flex-1 mb-3 md:mb-0">
                  <span className="text-lg font-medium text-gray-100">
                    {task.title}
                  </span>
                  <span className="block text-sm text-gray-400">
                    {task.completed
                      ? `Completed at: ${task.completedAt
                          ?.toDate()
                          .toLocaleTimeString()}`
                      : `Starts at: ${task.startTime
                          ?.toDate()
                          .toLocaleTimeString()}`}{' '}
                    | {task.estimatedHours}hr
                  </span>
                </div>
                <div className="flex items-center space-x-3 w-full md:w-auto">
                  {title === 'Active' && (
                    <>
                      <div className="flex flex-col items-center">
                        <span className="text-lg font-mono text-blue-300">
                          {formatStopwatch(elapsed)}
                        </span>
                        <span className="text-xs text-gray-400">
                          Time Elapsed
                        </span>
                      </div>
                      {!isRunning ? (
                        <button
                          onClick={() => onStart(task.id)}
                          className="px-3 py-1 bg-green-600 text-white text-sm font-semibold rounded-md hover:bg-green-700"
                        >
                          Start
                        </button>
                      ) : (
                        <button
                          onClick={() => onStop(task.id)}
                          className="px-3 py-1 bg-yellow-600 text-white text-sm font-semibold rounded-md hover:bg-yellow-700"
                        >
                          Stop
                        </button>
                      )}
                      <button
                        onClick={() => onComplete(task.id)}
                        className="px-3 py-1 bg-blue-600 text-white text-sm font-semibold rounded-md hover:bg-blue-700"
                      >
                        Complete
                      </button>
                    </>
                  )}
                  {title === 'Completed Today' && (
                    <span className="text-lg font-semibold text-green-400">
                      Done!
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// --- Sub-Component: ChartComponent ---
function ChartComponent({ title, data, dataKey, fill }) {
  if (data.length === 0) {
    return (
       <div>
        <h4 className="text-lg font-semibold text-white mb-2">{title}</h4>
        <p className="text-gray-400 italic">No data for this period.</p>
       </div>
    )
  }
  return (
    <div>
      <h4 className="text-lg font-semibold text-white mb-2">{title}</h4>
      <div style={{ width: '100%', height: 300 }}>
        <ResponsiveContainer>
          <BarChart
            data={data}
            margin={{
              top: 5,
              right: 20,
              left: -10,
              bottom: 5,
            }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="displayName" stroke="#9CA3AF" />
            <YAxis stroke="#9CA3AF" />
            <Tooltip
              contentStyle={{ backgroundColor: '#1F2937', border: 'none' }}
              labelStyle={{ color: '#F9FAFB' }}
            />
            <Legend wrapperStyle={{ color: '#F9FAFB' }} />
            <Bar dataKey={dataKey} fill={fill} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}