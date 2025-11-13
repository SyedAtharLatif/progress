import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
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
  where,
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

// --- Deployment Config ---
// These keys are loaded from Vercel's Environment Variables
const firebaseConfig = {
  apiKey: process.env.REACT_APP_API_KEY,
  authDomain: process.env.REACT_APP_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_PROJECT_ID,
  storageBucket: process.env.REACT_APP_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_APP_ID,
};
// --- End of Deployment Config ---

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Get App ID - Vercel will not have __app_id defined
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// --- Firestore Path Helpers ---
const getPrivateUserCollection = (userId) =>
  `artifacts/${appId}/users/${userId}`;
const getPublicDataCollection = () => `artifacts/${appId}/public/data`;

// --- Utility Functions ---
const getStartOfDate = (date) => {
  const newDate = new Date(date);
  newDate.setHours(0, 0, 0, 0);
  return newDate;
};

const formatStopwatch = (seconds) => {
  const h = Math.floor(seconds / 3600)
    .toString()
    .padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0');
  return `${h}:${m}:${s}`;
};

// --- Main App Component ---
function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // New Task State
  const [taskTitle, setTaskTitle] = useState('');
  const [startTime, setStartTime] = useState('');
  const [estimatedHours, setEstimatedHours] = useState(1);

  // Data State
  const [tasks, setTasks] = useState([]);
  const [allUserStats, setAllUserStats] = useState([]);
  const [dailyPushups, setDailyPushups] = useState(5);
  const [pushupPenaltyChecked, setPushupPenaltyChecked] = useState(false);

  // Timer State
  const [currentTime, setCurrentTime] = useState(new Date());
  const [activeTimers, setActiveTimers] = useState({}); // { taskId: seconds }

  // Chart Filter State
  const [filterType, setFilterType] = useState('today');

  // Confirmation Modal State
  const [showResetModal, setShowResetModal] = useState(false);

  // --- Authentication Effect ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        // User is signed in
        const userStatsDocRef = doc(
          db,
          getPublicDataCollection(),
          'userStats',
          currentUser.uid
        );
        const userStatsDoc = await getDoc(userStatsDocRef);

        if (!userStatsDoc.exists()) {
          // Create new public stats doc for this user
          await setDoc(userStatsDocRef, {
            displayName: currentUser.displayName,
            email: currentUser.email,
            tasksCompleted: 0,
            totalHours: 0,
            tasks: [], // Store task timestamps for filtering
            pushups: [], // Store pushup timestamps
          });
        }
        setUser(currentUser);
      } else {
        // User is signed out
        setUser(null);
      }
      setLoading(false);
    });

    // Cleanup subscription on unmount
    return () => unsubscribe();
  }, []);

  // --- Live Clock Effect ---
  useEffect(() => {
    const timerId = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timerId);
  }, []);

  // --- Stopwatch Timer Effect ---
  useEffect(() => {
    const timerIds = {};

    Object.keys(activeTimers).forEach((taskId) => {
      if (activeTimers[taskId].isRunning) {
        timerIds[taskId] = setInterval(() => {
          setActiveTimers((prev) => ({
            ...prev,
            [taskId]: {
              ...prev[taskId],
              seconds: prev[taskId].seconds + 1,
            },
          }));
        }, 1000);
      }
    });

    return () => {
      Object.values(timerIds).forEach(clearInterval);
    };
  }, [activeTimers]);

  // --- Sound Effect for Active Tasks ---
  useEffect(() => {
    const playSound = () => {
      try {
        const audioContext = new (window.AudioContext ||
          window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(440, audioContext.currentTime); // A4
        gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);

        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.2); // Play for 0.2 seconds
      } catch (e) {
        console.error('Audio playback failed:', e);
      }
    };

    tasks.forEach((task) => {
      if (
        !task.completed &&
        !task.notified &&
        new Date(task.startTime.toDate()) <= currentTime
      ) {
        playSound();
        // Mark as notified to prevent repeated beeps
        const taskDocRef = doc(
          db,
          getPrivateUserCollection(user.uid),
          'tasks',
          task.id
        );
        updateDoc(taskDocRef, { notified: true });
      }
    });
  }, [currentTime, tasks, user]);

  // --- Data Fetching Effects (Tasks, Stats, Pushups) ---
  useEffect(() => {
    if (!user) {
      setTasks([]);
      return;
    }

    // Fetch user's private tasks
    const tasksCollectionRef = collection(
      db,
      getPrivateUserCollection(user.uid),
      'tasks'
    );
    const qTasks = query(tasksCollectionRef);

    const unsubscribeTasks = onSnapshot(
      qTasks,
      (snapshot) => {
        const tasksData = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        setTasks(tasksData);
      },
      (err) => {
        console.error('Error fetching tasks:', err);
        setError('Failed to fetch tasks.');
      }
    );

    // Fetch user's pushup count for today
    const fetchPushups = async () => {
      const todayStr = getStartOfDate(new Date()).toISOString().split('T')[0];
      const pushupDocRef = doc(
        db,
        getPrivateUserCollection(user.uid),
        'pushups',
        todayStr
      );
      const pushupDoc = await getDoc(pushupDocRef);

      if (pushupDoc.exists()) {
        setDailyPushups(pushupDoc.data().count);
      } else {
        // Create new pushup doc for today
        await setDoc(pushupDocRef, { count: 5 });
        setDailyPushups(5);
      }
    };

    fetchPushups();

    // Cleanup subscriptions
    return () => unsubscribeTasks();
  }, [user]);

  // Fetch all public user stats for charts
  useEffect(() => {
    const statsCollectionRef = collection(
      db,
      getPublicDataCollection(),
      'userStats'
    );
    const qStats = query(statsCollectionRef);

    const unsubscribeStats = onSnapshot(
      qStats,
      (snapshot) => {
        const statsData = snapshot.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));
        setAllUserStats(statsData);
      },
      (err) => {
        console.error('Error fetching all user stats:', err);
        setError('Failed to fetch user stats for charts.');
      }
    );

    return () => unsubscribeStats();
  }, []);

  // --- Event Handlers ---

  const handleSignIn = async () => {
    setLoading(true);
    setError('');
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error('Sign-in error:', error);
      setError(`Failed to sign in with Google. Error: ${error.message}`);
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    setLoading(true);
    setError('');
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Sign-out error:', error);
      setError('Failed to sign out.');
      setLoading(false);
    }
  };

  const handleAddTask = async (e) => {
    e.preventDefault();
    if (!user || !taskTitle || !startTime || !estimatedHours) {
      setError('Please fill in all fields.');
      return;
    }
    setError('');

    try {
      // --- FIX: Create date object from local datetime-local input ---
      // This creates the date object correctly based on the user's local timezone
      const localStartDate = new Date(startTime);
      if (isNaN(localStartDate.getTime())) {
        setError('Invalid date format.');
        return;
      }
      // --- End of Fix ---

      const tasksCollectionRef = collection(
        db,
        getPrivateUserCollection(user.uid),
        'tasks'
      );
      await addDoc(tasksCollectionRef, {
        title: taskTitle,
        startTime: Timestamp.fromDate(localStartDate), // Convert local date to Firestore Timestamp
        estimatedHours: parseFloat(estimatedHours),
        completed: false,
        notified: false,
        timeElapsed: 0, // Store elapsed time in seconds
      });

      // Reset form
      setTaskTitle('');
      setStartTime('');
      setEstimatedHours(1);
    } catch (error) {
      console.error('Error adding task:', error);
      setError(`Failed to add task. Error: ${error.message}`);
    }
  };

  const handleToggleTaskTimer = (taskId, isRunning) => {
    setActiveTimers((prev) => {
      const currentTimer = prev[taskId] || { seconds: 0, isRunning: false };
      return {
        ...prev,
        [taskId]: {
          ...currentTimer,
          isRunning: !isRunning,
        },
      };
    });
  };

  const handleMarkAsComplete = async (task) => {
    if (!user) return;
    setError('');

    try {
      const taskDocRef = doc(
        db,
        getPrivateUserCollection(user.uid),
        'tasks',
        task.id
      );
      const publicStatsDocRef = doc(
        db,
        getPublicDataCollection(),
        'userStats',
        user.uid
      );

      const publicStatsDoc = await getDoc(publicStatsDocRef);
      if (!publicStatsDoc.exists()) {
        throw new Error('Public stats document does not exist.');
      }

      const statsData = publicStatsDoc.data();

      // Get elapsed time from state, or use 0 if timer was never started
      const elapsedSeconds = activeTimers[task.id]
        ? activeTimers[task.id].seconds
        : task.timeElapsed || 0;
      const elapsedHours = elapsedSeconds / 3600;

      // Update private task doc
      await updateDoc(taskDocRef, {
        completed: true,
        timeElapsed: elapsedSeconds,
      });

      // Update public stats doc
      const newTasksCompleted = (statsData.tasksCompleted || 0) + 1;
      const newTotalHours = (statsData.totalHours || 0) + elapsedHours;
      const newTasksArray = [
        ...(statsData.tasks || []),
        {
          id: task.id,
          completedAt: Timestamp.now(),
          hours: elapsedHours,
        },
      ];

      await updateDoc(publicStatsDocRef, {
        tasksCompleted: newTasksCompleted,
        totalHours: newTotalHours,
        tasks: newTasksArray,
      });

      // Clear the timer from state
      setActiveTimers((prev) => {
        const newState = { ...prev };
        delete newState[task.id];
        return newState;
      });
    } catch (error) {
      console.error('Error completing task:', error);
      setError(`Failed to complete task. Error: ${error.message}`);
    }
  };

  const handleAddPenalty = async () => {
    if (!user || pushupPenaltyChecked) return; // Prevent double-clicking
    setError('');
    setPushupPenaltyChecked(true); // Disable checkbox immediately

    try {
      const newPushupCount = dailyPushups + 5;
      const todayStr = getStartOfDate(new Date()).toISOString().split('T')[0];
      const pushupDocRef = doc(
        db,
        getPrivateUserCollection(user.uid),
        'pushups',
        todayStr
      );
      const publicStatsDocRef = doc(
        db,
        getPublicDataCollection(),
        'userStats',
        user.uid
      );

      // Update private pushup count for today
      await setDoc(pushupDocRef, { count: newPushupCount }, { merge: true });
      setDailyPushups(newPushupCount);

      // Update public stats with a new pushup entry
      const publicStatsDoc = await getDoc(publicStatsDocRef);
      if (!publicStatsDoc.exists()) {
        throw new Error('Public stats document does not exist.');
      }
      const statsData = publicStatsDoc.data();
      const newPushupsArray = [
        ...(statsData.pushups || []),
        {
          addedAt: Timestamp.now(),
          count: 5,
        },
      ];

      await updateDoc(publicStatsDocRef, {
        pushups: newPushupsArray,
      });
    } catch (error) {
      console.error('Error adding penalty:', error);
      setError(`Failed to add penalty. Error: ${error.message}`);
    } finally {
      // Re-enable checkbox after a short delay
      setTimeout(() => setPushupPenaltyChecked(false), 1000);
    }
  };

  const handleResetData = async () => {
    if (!user || user.email !== 'atharlatif200@gmail.com') {
      setError('You are not authorized to perform this action.');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const batch = writeBatch(db);

      // 1. Delete all private tasks
      const tasksCollectionRef = collection(
        db,
        getPrivateUserCollection(user.uid),
        'tasks'
      );
      const tasksSnapshot = await getDocs(tasksCollectionRef);
      tasksSnapshot.docs.forEach((d) => {
        batch.delete(d.ref);
      });

      // 2. Delete all private pushup docs
      const pushupsCollectionRef = collection(
        db,
        getPrivateUserCollection(user.uid),
        'pushups'
      );
      const pushupsSnapshot = await getDocs(pushupsCollectionRef);
      pushupsSnapshot.docs.forEach((d) => {
        batch.delete(d.ref);
      });

      // 3. Reset public stats doc
      const publicStatsDocRef = doc(
        db,
        getPublicDataCollection(),
        'userStats',
        user.uid
      );
      batch.update(publicStatsDocRef, {
        tasksCompleted: 0,
        totalHours: 0,
        tasks: [],
        pushups: [],
      });

      // Commit the batch
      await batch.commit();

      // Reset local state
      setTasks([]);
      setDailyPushups(5);
      setActiveTimers({});
      setShowResetModal(false);
    } catch (error) {
      console.error('Error resetting data:', error);
      setError(`Failed to reset data. Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  // --- Memos for Filtered Data ---

  // Categorize tasks
  const categorizedTasks = useMemo(() => {
    const today = getStartOfDate(currentTime);
    const upcoming = [];
    const active = [];
    const completed = [];

    tasks.forEach((task) => {
      const taskStartTime = new Date(task.startTime.toDate());

      if (task.completed) {
        completed.push(task);
      } else if (taskStartTime > currentTime) {
        upcoming.push(task);
      } else {
        active.push(task);
      }
    });

    const todayFilter = (task) =>
      getStartOfDate(task.startTime.toDate()).getTime() === today.getTime();

    return {
      upcomingToday: upcoming.filter(todayFilter),
      activeToday: active.filter(todayFilter),
      completedToday: completed.filter(todayFilter),
    };
  }, [tasks, currentTime]);

  // Filter chart data
  const filteredChartData = useMemo(() => {
    // --- FIX: Add this check ---
    // If there is no user, return empty data to prevent crash
    if (!user) {
      return { taskData: [], hourData: [], pushupData: [] };
    }
    // --- End of Fix ---

    const now = new Date();
    const today = getStartOfDate(now);
    const startOfWeek = getStartOfDate(
      new Date(now.setDate(now.getDate() - now.getDay()))
    );
    const startOfMonth = getStartOfDate(
      new Date(now.getFullYear(), now.getMonth(), 1)
    );

    let filterStartDate;
    switch (filterType) {
      case 'week':
        filterStartDate = startOfWeek;
        break;
      case 'month':
        filterStartDate = startOfMonth;
        break;
      case 'today':
        filterStartDate = today;
        break;
      default: // 'all'
        filterStartDate = new Date(0); // The beginning of time
    }

    const taskData = [];
    const hourData = [];
    const pushupData = [];

    allUserStats.forEach((statUser) => {
      const filteredTasks = statUser.tasks.filter(
        (task) => task.completedAt.toDate() >= filterStartDate
      );
      const filteredPushups = statUser.pushups.filter(
        (p) => p.addedAt.toDate() >= filterStartDate
      );

      const tasksCompleted = filteredTasks.length;
      const totalHours = filteredTasks.reduce((sum, t) => sum + t.hours, 0);
      const totalPushups = filteredPushups.reduce((sum, p) => sum + p.count, 0);

      taskData.push({
        name: statUser.displayName.split(' ')[0],
        Tasks: tasksCompleted,
      });
      hourData.push({
        name: statUser.displayName.split(' ')[0],
        Hours: parseFloat(totalHours.toFixed(2)),
      });
      pushupData.push({
        name: statUser.displayName.split(' ')[0],
        Pushups: totalPushups,
      });
    });

    return { taskData, hourData, pushupData };
  }, [allUserStats, filterType, user]);

  // --- Render Methods ---

  const renderTask = (task) => {
    const isRunning = activeTimers[task.id]
      ? activeTimers[task.id].isRunning
      : false;
    // --- FIX: Show timer even if not running, default to 0 ---
    const elapsedSeconds = activeTimers[task.id]
      ? activeTimers[task.id].seconds
      : task.timeElapsed || 0;
    // --- End of Fix ---

    return (
      <li
        key={task.id}
        className="mb-3 p-4 bg-gray-700 rounded-lg shadow-sm"
      >
        <div className="flex justify-between items-center">
          <div>
            <span className="font-semibold text-lg">{task.title}</span>
            <p className="text-sm text-gray-400">
              Starts: {new Date(task.startTime.toDate()).toLocaleTimeString()} |
              Est: {task.estimatedHours}h
            </p>
          </div>
          <div className="text-right">
            <button
              onClick={() => handleToggleTaskTimer(task.id, isRunning)}
              className={`px-4 py-2 rounded-md text-white font-semibold ${
                isRunning
                  ? 'bg-yellow-500 hover:bg-yellow-600'
                  : 'bg-blue-500 hover:bg-blue-600'
              } mr-2`}
            >
              {isRunning ? 'Pause' : 'Start Task'}
            </button>
            <button
              onClick={() => handleMarkAsComplete(task)}
              className="px-4 py-2 rounded-md bg-green-500 text-white font-semibold hover:bg-green-600"
            >
              Complete
            </button>
          </div>
        </div>
        <div className="mt-2 text-center">
          <span className="text-xl font-mono text-gray-200">
            Time Elapsed: {formatStopwatch(elapsedSeconds)}
          </span>
        </div>
      </li>
    );
  };

  const renderChart = (data, dataKey, color) => (
    <div className="mb-8">
      <h3 className="text-2xl font-semibold mb-4 text-white">{dataKey}</h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart
          data={data}
          margin={{
            top: 5,
            right: 30,
            left: 20,
            bottom: 5,
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#4a5568" />
          <XAxis dataKey="name" stroke="#cbd5e0" />
          <YAxis stroke="#cbd5e0" />
          <Tooltip
            contentStyle={{ backgroundColor: '#2d3748', border: 'none' }}
            labelStyle={{ color: '#e2e8f0' }}
          />
          <Legend />
          <Bar dataKey={dataKey} fill={color} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );

  const renderFilterButtons = () => (
    <div className="flex space-x-2 mb-6">
      <button
        onClick={() => setFilterType('today')}
        className={`px-4 py-2 rounded-md font-semibold ${
          filterType === 'today'
            ? 'bg-blue-500 text-white'
            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
        }`}
      >
        Today
      </button>
      <button
        onClick={() => setFilterType('week')}
        className={`px-4 py-2 rounded-md font-semibold ${
          filterType === 'week'
            ? 'bg-blue-500 text-white'
            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
        }`}
      >
        This Week
      </button>
      <button
        onClick={() => setFilterType('month')}
        className={`px-4 py-2 rounded-md font-semibold ${
          filterType === 'month'
            ? 'bg-blue-500 text-white'
            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
        }`}
      >
        This Month
      </button>
      <button
        onClick={() => setFilterType('all')}
        className={`px-4 py-2 rounded-md font-semibold ${
          filterType === 'all'
            ? 'bg-blue-500 text-white'
            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
        }`}
      >
        All Time
      </button>
    </div>
  );

  // --- Main Render ---

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center text-white">
        <h1 className="text-3xl">Loading...</h1>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center text-white p-4">
        <h1 className="text-4xl font-bold mb-4">Task Progress Tracker</h1>
        <p className="text-lg mb-8">
          Sign in to track your tasks and compare progress with friends.
        </p>
        <button
          onClick={handleSignIn}
          className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-lg shadow-md hover:bg-blue-700 transition duration-300"
        >
          Sign in with Google
        </button>
        {error && (
          <p className="mt-6 text-red-400 bg-red-900 bg-opacity-50 border border-red-400 p-3 rounded-md">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-200 p-4 md:p-8">
      {/* Confirmation Modal */}
      {showResetModal && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 p-6 rounded-lg shadow-xl max-w-sm w-full">
            <h2 className="text-2xl font-bold text-white mb-4">Are you sure?</h2>
            <p className="text-gray-300 mb-6">
              This action is irreversible. It will delete all your tasks and
              reset your stats to zero. Your friend's data will not be affected.
            </p>
            <div className="flex justify-end space-x-4">
              <button
                onClick={() => setShowResetModal(false)}
                className="px-4 py-2 rounded-md bg-gray-600 text-white font-semibold hover:bg-gray-500"
              >
                Cancel
              </button>
              <button
                onClick={handleResetData}
                className="px-4 py-2 rounded-md bg-red-600 text-white font-semibold hover:bg-red-700"
              >
                Yes, Reset All My Data
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="flex flex-col md:flex-row justify-between md:items-center mb-8 pb-4 border-b border-gray-700">
        <div>
          <h1 className="text-4xl font-bold text-white">
            Welcome, {user.displayName.split(' ')[0]}
          </h1>
          <p className="text-sm text-gray-400 mt-2">
            Your User ID (for debugging): {user.uid}
          </p>
        </div>
        <div className="flex flex-col md:flex-row items-start md:items-center space-y-2 md:space-y-0 md:space-x-4 mt-4 md:mt-0">
          {/* Admin-only Reset Button */}
          {user.email === 'atharlatif200@gmail.com' && (
            <button
              onClick={() => setShowResetModal(true)}
              className="px-4 py-2 rounded-md bg-red-600 text-white font-semibold hover:bg-red-700"
            >
              Reset All My Data
            </button>
          )}
          <button
            onClick={handleSignOut}
            className="px-4 py-2 rounded-md bg-gray-700 text-white font-semibold hover:bg-gray-600"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Error Display */}
      {error && (
        <div className="mb-6 p-3 rounded-md bg-red-900 bg-opacity-50 text-red-400 border border-red-400">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left Column: Task Management */}
        <div>
          {/* Add Task Form */}
          <div className="bg-gray-800 p-6 rounded-lg shadow-lg mb-8">
            <h2 className="text-2xl font-semibold mb-4 text-white">
              Add a New Task for Today
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
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  placeholder="e.g., Read 1 chapter"
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="startTime"
                    className="block text-sm font-medium text-gray-300 mb-1"
                  >
                    Start Time (Today)
                  </label>
                  <input
                    type="datetime-local"
                    id="startTime"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label
                    htmlFor="estimatedHours"
                    className="block text-sm font-medium text-gray-300 mb-1"
                  >
                    Estimated Hours
                  </label>
                  <input
                    type="number"
                    id="estimatedHours"
                    value={estimatedHours}
                    onChange={(e) => setEstimatedHours(e.target.value)}
                    min="0.1"
                    step="0.1"
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <button
                type="submit"
                className="w-full px-4 py-2 bg-blue-600 text-white font-semibold rounded-lg shadow-md hover:bg-blue-700 transition duration-300"
              >
                Add Task
              </button>
            </form>
          </div>

          {/* Daily Penalty Section */}
          <div className="bg-gray-800 p-6 rounded-lg shadow-lg mb-8">
            <h2 className="text-2xl font-semibold mb-4 text-white">
              Daily Penalty
            </h2>
            <div className="flex items-center justify-between">
              <span className="text-lg">
                Total Pushups for Today: <strong>{dailyPushups}</strong>
              </span>
              <div className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  id="penalty"
                  checked={pushupPenaltyChecked}
                  onChange={handleAddPenalty}
                  className="h-5 w-5 rounded text-blue-500 bg-gray-700 border-gray-600 focus:ring-blue-500"
                />
                <label htmlFor="penalty" className="text-gray-300">
                  Add Penalty (+5 Pushups)
                </label>
              </div>
            </div>
          </div>

          {/* Task Lists */}
          <div>
            {/* Active Tasks */}
            <div className="mb-8">
              <h2 className="text-2xl font-semibold mb-4 text-yellow-400">
                Active Tasks (
                {categorizedTasks.activeToday.length})
              </h2>
              {categorizedTasks.activeToday.length > 0 ? (
                <ul className="space-y-3">
                  {categorizedTasks.activeToday
                    .sort(
                      (a, b) =>
                        a.startTime.toDate().getTime() -
                        b.startTime.toDate().getTime()
                    )
                    .map(renderTask)}
                </ul>
              ) : (
                <p className="text-gray-400">
                  No tasks are active. Get ready for the next one!
                </p>
              )}
            </div>

            {/* Upcoming Tasks */}
            <div className="mb-8">
              <h2 className="text-2xl font-semibold mb-4 text-blue-400">
                Upcoming Tasks (
                {categorizedTasks.upcomingToday.length})
              </h2>
              {categorizedTasks.upcomingToday.length > 0 ? (
                <ul className="space-y-3">
                  {categorizedTasks.upcomingToday
                    .sort(
                      (a, b) =>
                        a.startTime.toDate().getTime() -
                        b.startTime.toDate().getTime()
                    )
                    .map((task) => (
                      <li
                        key={task.id}
                        className="p-4 bg-gray-800 rounded-lg shadow-sm flex justify-between items-center"
                      >
                        <div>
                          <span className="font-semibold text-lg">
                            {task.title}
                          </span>
                          <p className="text-sm text-gray-400">
                            Starts:{' '}
                            {new Date(
                              task.startTime.toDate()
                            ).toLocaleTimeString()}{' '}
                            | Est: {task.estimatedHours}h
                          </p>
                        </div>
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="text-gray-400">
                  No more tasks scheduled for today.
                </p>
              )}
            </div>

            {/* Completed Tasks */}
            <div className="mb-8">
              <h2 className="text-2xl font-semibold mb-4 text-green-400">
                Completed Tasks (
                {categorizedTasks.completedToday.length})
              </h2>
              {categorizedTasks.completedToday.length > 0 ? (
                <ul className="space-y-3">
                  {categorizedTasks.completedToday
                    .sort(
                      (a, b) =>
                        a.startTime.toDate().getTime() -
                        b.startTime.toDate().getTime()
                    )
                    .map((task) => (
                      <li
                        key={task.id}
                        className="p-4 bg-gray-800 rounded-lg shadow-sm opacity-60"
                      >
                        <span className="font-semibold text-lg line-through">
                          {task.title}
                        </span>
                        <p className="text-sm text-gray-500">
                          Time Spent:{' '}
                          {formatStopwatch(task.timeElapsed || 0)}
                        </p>
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="text-gray-400">No tasks completed yet today.</p>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Charts */}
        <div className="bg-gray-800 p-6 rounded-lg shadow-lg">
          <h2 className="text-3xl font-bold mb-6 text-white">
            Productivity Comparison
          </h2>
          {renderFilterButtons()}
          {renderChart(
            filteredChartData.taskData,
            'Tasks',
            '#3b82f6'
          )}{' '}
          {/* blue */}
          {renderChart(
            filteredChartData.hourData,
            'Hours',
            '#10b981'
          )}{' '}
          {/* green */}
          {renderChart(
            filteredChartData.pushupData,
            'Pushups',
            '#ef4444'
          )}{' '}
          {/* red */}
        </div>
      </div>
    </div>
  );
}

export default App;