import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  addDoc,
  getDoc,
  getDocs,
  collection,
  query,
  where,
  onSnapshot,
  writeBatch,
  Timestamp,
  serverTimestamp,
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

// --- Firebase Configuration ---
// This part is automatically configured by Vercel from your Environment Variables
const firebaseConfig = {
  apiKey: process.env.REACT_APP_API_KEY,
  authDomain: process.env.REACT_APP_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_PROJECT_ID,
  storageBucket: process.env.REACT_APP_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_APP_ID,
};

// --- Initialize Firebase ---
// We add a check to ensure it only initializes once.
let app;
let db;
let auth;

try {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
} catch (error) {
  console.error("Firebase initialization error:", error);
  if (error.code === 'duplicate-app') {
    // This can happen in React's strict mode, it's safe to ignore
    app = initializeApp(firebaseConfig, "duplicate-app");
    db = getFirestore(app);
    auth = getAuth(app);
  }
}

// --- App ID Management ---
// This ensures your app's data is isolated in Firestore.
const appId = 'progress-tracker-v2';

// --- Admin Email ---
// Only this email will see the "Reset" button
const ADMIN_EMAIL = 'atharlatif200@gmail.com';

// --- Main App Component ---
export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [tasks, setTasks] = useState([]);
  const [allUserStats, setAllUserStats] = useState([]);
  const [allPushups, setAllPushups] = useState([]);
  const [dailyPushups, setDailyPushups] = useState({ id: null, count: 5 });

  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskTime, setNewTaskTime] = useState('');
  const [newTaskHours, setNewTaskHours] = useState('1');

  const [currentTime, setCurrentTime] = useState(new Date());
  const [taskTimers, setTaskTimers] = useState({}); // Stores running timers for tasks

  const [chartFilter, setChartFilter] = useState('today');
  const [showConfirmReset, setShowConfirmReset] = useState(false);

  // --- Audio for Task Alert ---
  // A simple beep sound
  const playSound = () => {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // A nice "beep"
      gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
      
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.2); // Play for 0.2 seconds
    } catch (e) {
      console.error("Could not play sound:", e);
    }
  };

  // --- Live Clock and Task Activation ---
  useEffect(() => {
    const timerId = setInterval(() => {
      const now = new Date();
      setCurrentTime(now);

      // Check for tasks that need to be activated
      tasks.forEach(task => {
        if (task.status === 'upcoming' && task.startTime.toDate() <= now) {
          // Play sound and update state
          playSound();
          // This task will be moved to "active" by the filter logic automatically
          // We can also trigger a re-check or just let the state filters handle it
          setTasks(prevTasks => 
            prevTasks.map(t => 
              t.id === task.id ? { ...t, status: 'active' } : t
            )
          );
        }
      });
    }, 1000); // Update every second

    return () => clearInterval(timerId);
  }, [tasks]); // Re-run when tasks change

  // --- Authentication ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setLoading(true);
      if (currentUser) {
        // Create user profile in Firestore if it doesn't exist
        const userStatRef = doc(db, 'artifacts', appId, 'public', 'data', 'userStats', currentUser.uid);
        const userDoc = await getDoc(userStatRef);

        if (!userDoc.exists()) {
          await setDoc(userStatRef, {
            displayName: currentUser.displayName,
            email: currentUser.email,
            tasksCompleted: 0,
            totalHours: 0,
          });
        }
        setUser(currentUser);
      } else {
        setUser(null);
      }
      setLoading(false);
      setError(null);
    });
    return () => unsubscribe();
  }, []);

  // --- Real-time Data Listeners ---
  useEffect(() => {
    if (!user) {
      setTasks([]);
      setAllUserStats([]);
      setAllPushups([]);
      return;
    }

    // Listener for THIS user's private tasks
    const tasksQuery = query(
      collection(db, 'artifacts', appId, 'users', user.uid, 'tasks')
    );
    const tasksUnsub = onSnapshot(tasksQuery, (snapshot) => {
      const userTasks = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      }));
      setTasks(userTasks);
    }, (err) => console.error("Error fetching tasks:", err));

    // Listener for ALL users' public stats
    const statsQuery = query(
      collection(db, 'artifacts', appId, 'public', 'data', 'userStats')
    );
    const statsUnsub = onSnapshot(statsQuery, (snapshot) => {
      const stats = snapshot.docs.map(doc => ({
        uid: doc.id,
        ...doc.data(),
      }));
      setAllUserStats(stats);
    }, (err) => console.error("Error fetching stats:", err));

    // Listener for ALL users' public pushup history
    const pushupsQuery = query(
      collection(db, 'artifacts', appId, 'public', 'data', 'pushupHistory')
    );
    const pushupsUnsub = onSnapshot(pushupsQuery, (snapshot) => {
      const history = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      }));
      setAllPushups(history);
    }, (err) => console.error("Error fetching pushup history:", err));

    // Listener for THIS user's daily pushup count
    const today = new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
    const dailyPushupRef = doc(db, 'artifacts', appId, 'users', user.uid, 'dailyPushups', today);
    
    const dailyPushupUnsub = onSnapshot(dailyPushupRef, async (docSnap) => {
      if (docSnap.exists()) {
        setDailyPushups({ id: docSnap.id, ...docSnap.data() });
      } else {
        // No doc for today, create one
        await setDoc(dailyPushupRef, { count: 5, date: Timestamp.now(), uid: user.uid });
        setDailyPushups({ id: docSnap.id, count: 5 }); // The listener will update this, but set it locally too
      }
    }, (err) => console.error("Error fetching daily pushups:", err));


    return () => {
      tasksUnsub();
      statsUnsub();
      pushupsUnsub();
      dailyPushupUnsub();
    };
  }, [user]);

  // --- Authentication Actions ---
  const signIn = async () => {
    try {
      setError(null);
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      console.error("Sign-in error:", err);
      setError("Failed to sign in with Google. Ensure popups are allowed and you've authorized the domain in Firebase.");
    }
  };

  const logOut = async () => {
    await signOut(auth);
  };

  // --- Task Management ---
  const handleAddTask = async (e) => {
    e.preventDefault();
    if (!user || !newTaskTitle || !newTaskTime || !newTaskHours) return;

    // Combine date and time
    const [datePart] = new Date().toISOString().split('T');
    const fullISOString = `${datePart}T${newTaskTime}:00`;
    const startTime = new Date(fullISOString);
    
    if (isNaN(startTime.getTime())) {
      setError("Invalid time format. Use HH:MM.");
      return;
    }

    try {
      await addDoc(collection(db, 'artifacts', appId, 'users', user.uid, 'tasks'), {
        title: newTaskTitle,
        startTime: Timestamp.fromDate(startTime),
        estimatedHours: parseFloat(newTaskHours),
        status: 'upcoming', // 'upcoming', 'active', 'completed'
        createdAt: serverTimestamp(),
        uid: user.uid,
      });
      setNewTaskTitle('');
      setNewTaskTime('');
      setNewTaskHours('1');
      setError(null);
    } catch (err) {
      console.error("Error adding task:", err);
      setError("Failed to add task.");
    }
  };

  const completeTask = async (task) => {
    if (!user) return;

    const batch = writeBatch(db);

    // 1. Update the private task document
    const taskRef = doc(db, 'artifacts', appId, 'users', user.uid, 'tasks', task.id);
    batch.update(taskRef, { status: 'completed', completedAt: serverTimestamp() });

    // 2. Update the public user stats
    const statRef = doc(db, 'artifacts', appId, 'public', 'data', 'userStats', user.uid);
    const statDoc = await getDoc(statRef);
    const newTotalTasks = (statDoc.data()?.tasksCompleted || 0) + 1;
    const newTotalHours = (statDoc.data()?.totalHours || 0) + task.estimatedHours;
    
    batch.update(statRef, {
      tasksCompleted: newTotalTasks,
      totalHours: newTotalHours,
    });
    
    // 3. Stop any running timer
    stopTaskTimer(task.id);

    await batch.commit();
  };

  // --- Task Timer Controls ---
  const startTaskTimer = (taskId) => {
    // Clear any existing timer for this task first
    setTaskTimers(prev => {
      if (prev[taskId]) {
        clearInterval(prev[taskId].intervalId);
      }
      // Start a new timer
      const newIntervalId = setInterval(() => {
        setTaskTimers(currentTimers => {
          if (!currentTimers[taskId]) {
            clearInterval(newIntervalId); // Safety clear
            return currentTimers;
          }
          return {
            ...currentTimers,
            [taskId]: {
              ...currentTimers[taskId],
              elapsed: (currentTimers[taskId].elapsed || 0) + 1,
            }
          };
        });
      }, 1000);

      return {
        ...prev,
        [taskId]: {
          intervalId: newIntervalId,
          elapsed: prev[taskId]?.elapsed || 0, // Resume from where it left off or start at 0
        }
      };
    });
  };

  const stopTaskTimer = (taskId) => {
    setTaskTimers(prev => {
      if (prev[taskId]) {
        clearInterval(prev[taskId].intervalId);
        // We keep the elapsed time, but remove the intervalId
        const { intervalId, ...rest } = prev[taskId];
        return { ...prev, [taskId]: rest };
      }
      return prev;
    });
  };

  // --- Penalty Pushups ---
  const addPenaltyPushups = async () => {
    if (!user) return;
    
    const today = new Date().toISOString().split('T')[0];
    const dailyPushupRef = doc(db, 'artifacts', appId, 'users', user.uid, 'dailyPushups', today);

    const newCount = dailyPushups.count + 5;
    
    // Use set with merge to create or update
    await setDoc(dailyPushupRef, 
      { count: newCount, date: Timestamp.now(), uid: user.uid },
      { merge: true }
    );
    
    // Also add to public history for charts
    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'pushupHistory'), {
      uid: user.uid,
      displayName: user.displayName,
      added: 5,
      createdAt: serverTimestamp(),
    });
  };

  // --- Reset User Data ---
  const handleResetData = async () => {
    if (!user) return;

    // This is a destructive action, so we batch it.
    const batch = writeBatch(db);

    // 1. Delete all of the user's private tasks
    const tasksQuery = query(collection(db, 'artifacts', appId, 'users', user.uid, 'tasks'));
    const tasksSnapshot = await getDocs(tasksQuery);
    tasksSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    
    // 2. Delete all of the user's daily pushup docs
    const pushupsQuery = query(collection(db, 'artifacts', appId, 'users', user.uid, 'dailyPushups'));
    const pushupsSnapshot = await getDocs(pushupsQuery);
    pushupsSnapshot.docs.forEach(doc => batch.delete(doc.ref));

    // 3. Reset the user's public stat doc
    const statRef = doc(db, 'artifacts', appId, 'public', 'data', 'userStats', user.uid);
    batch.update(statRef, { tasksCompleted: 0, totalHours: 0 });

    // 4. Delete all of the user's public pushup history
    const pushupHistoryQuery = query(
      collection(db, 'artifacts', appId, 'public', 'data', 'pushupHistory'),
      where('uid', '==', user.uid)
    );
    const pushupHistorySnapshot = await getDocs(pushupHistoryQuery);
    pushupHistorySnapshot.docs.forEach(doc => batch.delete(doc.ref));
    
    try {
      await batch.commit();
      setDailyPushups({ id: null, count: 5 }); // Reset local state
      setShowConfirmReset(false); // Close modal
      setError(null);
    } catch (err) {
      console.error("Error resetting data:", err);
      setError("Failed to reset data.");
    }
  };


  // --- Data Filtering and Memoization ---
  const { upcomingTasks, activeTasks, completedTasks } = useMemo(() => {
    const now = currentTime;
    const todayStart = new Date(now.setHours(0, 0, 0, 0));
    const todayEnd = new Date(now.setHours(23, 59, 59, 999));

    return tasks.reduce((acc, task) => {
      const taskTime = task.startTime?.toDate();
      if (!taskTime) return acc;
      
      const isToday = taskTime >= todayStart && taskTime <= todayEnd;

      if (task.status === 'completed') {
        acc.completedTasks.push(task);
      } else if (isToday && taskTime <= now && task.status !== 'completed') {
        acc.activeTasks.push(task);
      } else if (isToday && taskTime > now && task.status !== 'completed') {
        acc.upcomingTasks.push(task);
      }
      return acc;
    }, { upcomingTasks: [], activeTasks: [], completedTasks: [] });
  }, [tasks, currentTime]);

  const filteredChartData = useMemo(() => {
    const now = new Date();
    const today = now.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(today).setDate(now.getDate() - now.getDay());
    const startOfMonth = new Date(today).setMonth(now.getMonth(), 1);

    const filterTasks = (task) => {
      if (!task.completedAt) return false;
      const completedTime = task.completedAt.toDate().getTime();

      if (chartFilter === 'today') return completedTime >= today;
      if (chartFilter === 'week') return completedTime >= startOfWeek;
      if (chartFilter === 'month') return completedTime >= startOfMonth;
      if (chartFilter === 'all') return true;
      return false;
    };
    
    const filterPushups = (pushup) => {
      if (!pushup.createdAt) return false;
      const createdTime = pushup.createdAt.toDate().getTime();
      
      if (chartFilter === 'today') return createdTime >= today;
      if (chartFilter === 'week') return createdTime >= startOfWeek;
      if (chartFilter === 'month') return createdTime >= startOfMonth;
      if (chartFilter === 'all') return true;
      return false;
    };
    
    // 1. Process tasks data
    const userTaskData = allUserStats.map(user => {
      // We need to fetch all tasks for all users for this to work...
      // This is NOT scalable.
      // A better way is to use the `allUserStats` which is already aggregated.
      // But `allUserStats` is not time-based.
      //
      // Let's change the logic: We'll use allUserStats for "All Time"
      // and for other filters, we'll have to use the user's local tasks.
      // This means you can only compare *your* filtered data to *everyone's* total.
      //
      // A proper solution requires querying all public tasks, which is complex.
      // Let's use the public pushup history, which *is* filterable.
      
      return {
        name: user.displayName,
        tasksCompleted: user.tasksCompleted,
        totalHours: user.totalHours,
      };
    });

    // 2. Process pushup data
    const pushupData = allPushups.filter(filterPushups).reduce((acc, pushup) => {
      const name = pushup.displayName;
      if (!acc[name]) {
        acc[name] = { name, totalPushups: 0 };
      }
      acc[name].totalPushups += pushup.added;
      return acc;
    }, {});
    
    // For 'all' filter, use the aggregated stats for tasks
    if (chartFilter === 'all') {
      return {
        taskData: userTaskData,
        hourData: userTaskData,
        pushupData: Object.values(pushupData),
      };
    }
    
    // For filtered views, we can only really filter data we have.
    // Let's filter the local user's tasks and the public pushup history
    
    const filteredLocalTasks = tasks.filter(filterTasks);
    
    const localUserStats = {
      name: user.displayName,
      tasksCompleted: filteredLocalTasks.length,
      totalHours: filteredLocalTasks.reduce((sum, t) => sum + t.estimatedHours, 0)
    };
    
    // This isn't a great comparison, but it's what's possible with the current data structure
    // We'll show the local user's filtered stats vs. everyone else's total stats
    const otherUsersTaskData = userTaskData
      .filter(u => u.name !== user.displayName)
      .map(u => ({...u, name: `${u.name} (All Time)`}));
      
    const taskData = [localUserStats, ...otherUsersTaskData];

    return {
      taskData: taskData,
      hourData: taskData,
      pushupData: Object.values(pushupData),
    };

  }, [chartFilter, allUserStats, allPushups, tasks, user]);


  // --- Helper Functions ---
  const formatTimer = (seconds) => {
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  // --- Render Logic ---
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-900 text-white">
        Loading...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 font-sans p-4 md:p-8">
      {/* --- Confirmation Modal --- */}
      {showConfirmReset && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 p-6 rounded-lg shadow-xl max-w-sm w-full">
            <h2 className="text-xl font-bold text-red-400 mb-4">Are you sure?</h2>
            <p className="text-gray-300 mb-6">
              This will permanently delete all your tasks, task history, and pushup history.
              Your friend's data will not be affected. This action cannot be undone.
            </p>
            <div className="flex justify-end space-x-4">
              <button
                onClick={() => setShowConfirmReset(false)}
                className="px-4 py-2 bg-gray-600 rounded-md hover:bg-gray-500 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleResetData}
                className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-500 transition-colors"
              >
                Yes, Reset All My Data
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* --- Header --- */}
      <header className="flex flex-col md:flex-row justify-between items-center mb-8 pb-4 border-b border-gray-700">
        <h1 className="text-4xl font-bold text-white mb-4 md:mb-0">Task Progress Tracker</h1>
        {!user ? (
          <button
            onClick={signIn}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg shadow-md hover:bg-blue-500 transition-all"
          >
            Sign in with Google
          </button>
        ) : (
          <div className="flex flex-col items-center md:items-end">
            <div className="flex items-center space-x-4">
              <img
                src={user.photoURL}
                alt={user.displayName}
                className="w-12 h-12 rounded-full border-2 border-blue-400"
              />
              <div className="text-right">
                <span className="text-lg font-semibold">{user.displayName}</span>
                <button
                  onClick={logOut}
                  className="block text-sm text-blue-400 hover:text-blue-300"
                >
                  Sign Out
                </button>
              </div>
            </div>
          </div>
        )}
      </header>

      {error && <div className="bg-red-800 border border-red-600 text-red-100 px-4 py-3 rounded-lg mb-6">{error}</div>}

      {/* --- Main Content (Logged in) --- */}
      {user && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* --- Left Column: Tasks and Actions --- */}
          <div className="lg:col-span-2 space-y-8">
            
            {/* --- Add New Task Form --- */}
            <div className="bg-gray-800 p-6 rounded-lg shadow-xl">
              <h2 className="text-2xl font-semibold mb-4 text-white">Add a New Task for Today</h2>
              <form onSubmit={handleAddTask} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-3">
                  <label htmlFor="title" className="block text-sm font-medium text-gray-300 mb-1">Task Title</label>
                  <input
                    type="text"
                    id="title"
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                    placeholder="e.g., Read 1 chapter"
                    className="w-full bg-gray-700 border border-gray-600 rounded-md p-3 text-white focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="time" className="block text-sm font-medium text-gray-300 mb-1">Start Time (HH:MM)</label>
                  <input
                    type="time"
                    id="time"
                    value={newTaskTime}
                    onChange={(e) => setNewTaskTime(e.target.value)}
                    className="w-full bg-gray-700 border border-gray-600 rounded-md p-3 text-white focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="hours" className="block text-sm font-medium text-gray-300 mb-1">Estimated Hours</label>
                  <input
                    type="number"
                    id="hours"
                    min="0.1"
                    step="0.1"
                    value={newTaskHours}
                    onChange={(e) => setNewTaskHours(e.target.value)}
                    className="w-full bg-gray-700 border border-gray-600 rounded-md p-3 text-white focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <button
                  type="submit"
                  className="sm:col-span-3 w-full px-6 py-3 bg-blue-600 text-white font-semibold rounded-lg shadow-md hover:bg-blue-500 transition-all"
                >
                  Add Task
                </button>
              </form>
            </div>
            
            {/* --- Daily Penalty Section --- */}
            <div className="bg-gray-800 p-6 rounded-lg shadow-xl">
              <h2 className="text-2xl font-semibold mb-4 text-white">Daily Penalty Pushups</h2>
              <div className="flex items-center justify-between">
                <p className="text-lg text-gray-300">
                  Today's Total: <span className="font-bold text-2xl text-red-400">{dailyPushups.count}</span>
                </p>
                <button
                  onClick={addPenaltyPushups}
                  className="px-6 py-3 bg-red-600 text-white font-semibold rounded-lg shadow-md hover:bg-red-500 transition-all"
                >
                  Add 5 Pushups
                </button>
              </div>
            </div>

            {/* --- Task Lists --- */}
            <div className="space-y-6">
              {/* Active Tasks */}
              <TaskSection title="Active Tasks" tasks={activeTasks} taskTimers={taskTimers} onComplete={completeTask} onStart={startTaskTimer} onStop={stopTaskTimer} formatTimer={formatTimer} />
              {/* Upcoming Tasks */}
              <TaskSection title="Upcoming Tasks" tasks={upcomingTasks} onComplete={completeTask} />
              {/* Completed Tasks */}
              <TaskSection title="Completed Tasks" tasks={completedTasks} />
            </div>

          </div>

          {/* --- Right Column: Stats and Profile --- */}
          <div className="lg:col-span-1 space-y-8">
            
            {/* --- User Profile Info --- */}
            <div className="bg-gray-800 p-6 rounded-lg shadow-xl">
              <h2 className="text-2xl font-semibold mb-4 text-white">Your Profile</h2>
              <p className="text-gray-300 mb-4">Share this ID with your friend so they know who you are on the charts (this is not a key!):</p>
              <input 
                type="text"
                readOnly
                value={user.uid}
                className="w-full bg-gray-700 border border-gray-600 rounded-md p-2 text-sm text-gray-300 mb-4"
                onFocus={(e) => e.target.select()}
              />
              {/* --- Admin Only Reset Button --- */}
              {user && user.email === ADMIN_EMAIL && (
                <button
                  onClick={() => setShowConfirmReset(true)}
                  className="w-full px-4 py-2 bg-red-800 text-white text-sm font-semibold rounded-md hover:bg-red-700 transition-colors"
                >
                  Reset All My Data (Admin)
                </button>
              )}
            </div>

            {/* --- Charts --- */}
            <div className="bg-gray-800 p-6 rounded-lg shadow-xl">
              <h2 className="text-2xl font-semibold mb-4 text-white">Productivity Comparison</h2>
              
              {/* Chart Filters */}
              <div className="flex justify-center space-x-2 mb-6">
                {['today', 'week', 'month', 'all'].map(filter => (
                  <button
                    key={filter}
                    onClick={() => setChartFilter(filter)}
                    className={`capitalize px-4 py-2 text-sm font-medium rounded-md transition-all ${
                      chartFilter === filter 
                        ? 'bg-blue-600 text-white' 
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    {filter === 'all' ? 'All Time' : `This ${filter}`}
                  </button>
                ))}
              </div>

              {/* Charts */}
              <div className="space-y-8">
                <ChartContainer title="Tasks Completed">
                  <BarChart data={filteredChartData.taskData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#4a5568" />
                    <XAxis dataKey="name" stroke="#9ca3af" />
                    <YAxis stroke="#9ca3af" />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Bar dataKey="tasksCompleted" fill="#3b82f6" />
                  </BarChart>
                </ChartContainer>

                <ChartContainer title="Total Hours">
                  <BarChart data={filteredChartData.hourData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#4a5568" />
                    <XAxis dataKey="name" stroke="#9ca3af" />
                    <YAxis stroke="#9ca3af" />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Bar dataKey="totalHours" fill="#10b981" />
                  </BarChart>
                </ChartContainer>
                
                <ChartContainer title="Total Pushups Added">
                  <BarChart data={filteredChartData.pushupData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#4a5568" />
                    <XAxis dataKey="name" stroke="#9ca3af" />
                    <YAxis stroke="#9ca3af" />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Bar dataKey="totalPushups" fill="#ef4444" />
                  </BarChart>
                </ChartContainer>
              </div>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Helper Components ---

// TaskSection: Renders a list of tasks under a title
function TaskSection({ title, tasks, onComplete, onStart, onStop, taskTimers, formatTimer }) {
  if (tasks.length === 0) {
    return null; // Don't render empty sections
  }

  return (
    <div className="bg-gray-800 p-6 rounded-lg shadow-xl">
      <h2 className="text-2xl font-semibold mb-4 text-white">{title} ({tasks.length})</h2>
      <ul className="space-y-4">
        {tasks.sort((a, b) => a.startTime.seconds - b.startTime.seconds).map(task => (
          <li key={task.id} className="flex flex-col sm:flex-row sm:items-center justify-between bg-gray-700 p-4 rounded-lg shadow">
            <div>
              <span className="text-lg font-medium text-white">{task.title}</span>
              <p className="text-sm text-gray-400">
                Starts: {new Date(task.startTime.toDate()).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} | 
                Hours: {task.estimatedHours}
              </p>
              {task.status === 'active' && taskTimers && taskTimers[task.id] && (
                <p className="text-lg font-mono text-yellow-300">
                  Time Elapsed: {formatTimer(taskTimers[task.id].elapsed)}
                </p>
              )}
            </div>
            
            {/* Task Action Buttons */}
            <div className="flex-shrink-0 flex space-x-2 mt-4 sm:mt-0">
              {task.status === 'active' && (
                <>
                  {taskTimers && taskTimers[task.id] && taskTimers[task.id].intervalId ? (
                    <button
                      onClick={() => onStop(task.id)}
                      className="px-4 py-2 text-sm font-medium bg-yellow-600 text-white rounded-md hover:bg-yellow-500 transition-colors"
                    >
                      Pause
                    </button>
                  ) : (
                    <button
                      onClick={() => onStart(task.id)}
                      className="px-4 py-2 text-sm font-medium bg-green-600 text-white rounded-md hover:bg-green-500 transition-colors"
                    >
                      Start
                    </button>
                  )}
                  <button
                    onClick={() => onComplete(task)}
                    className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-500 transition-colors"
                  >
                    Complete
                  </button>
                </>
              )}
              {task.status === 'upcoming' && (
                <button
                  onClick={() => onComplete(task)}
                  className="px-4 py-2 text-sm font-medium bg-gray-600 text-white rounded-md hover:bg-gray-500 transition-colors"
                >
                  Mark Complete
                </button>
              )}
              {task.status === 'completed' && (
                <span className="text-green-400 font-semibold">Completed</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ChartContainer: A simple wrapper for charts
function ChartContainer({ title, children }) {
  return (
    <div>
      <h3 className="text-lg font-semibold text-center text-gray-300 mb-4">{title}</h3>
      <div style={{ width: '100%', height: 300 }}>
        <ResponsiveContainer>
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// CustomTooltip: A styled tooltip for charts
function CustomTooltip({ active, payload, label }) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-gray-700 border border-gray-600 p-3 rounded-md shadow-lg">
        <p className="text-base font-semibold text-white">{label}</p>
        <p className="text-sm" style={{ color: payload[0].fill }}>
          {`${payload[0].name}: ${payload[0].value}`}
        </p>
      </div>
    );
  }
  return null;
}