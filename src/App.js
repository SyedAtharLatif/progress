import React, { useState, useEffect, useMemo } from 'react';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { 
    getAuth, 
    onAuthStateChanged, 
    signInWithPopup, 
    GoogleAuthProvider, 
    signOut,
    // We will not use anonymous or custom token auth for the deployed app
} from 'firebase/auth';
import { 
    getFirestore, 
    doc, 
    setDoc, 
    addDoc, 
    getDoc,
    updateDoc,
    collection, 
    query, 
    where, 
    onSnapshot,
    increment,
    // setLogLevel // Not needed for production
} from 'firebase/firestore';
import { 
    BarChart, 
    Bar, 
    XAxis, 
    YAxis, 
    CartesianGrid, 
    Tooltip, 
    Legend, 
    ResponsiveContainer 
} from 'recharts';

// --- Firebase Configuration ---
// These keys will be set in your Vercel project settings
// This is the correct configuration for your deployment
const firebaseConfig = {
  apiKey: process.env.REACT_APP_API_KEY,
  authDomain: process.env.REACT_APP_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_PROJECT_ID,
  storageBucket: process.env.REACT_APP_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_APP_ID
};

// Use the Project ID as the unique app ID for Firestore paths
const appId = process.env.REACT_APP_PROJECT_ID || 'default-project-id';


// --- Initialize Firebase ---
// Use getApps() to avoid re-initializing on hot reloads
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const db = getFirestore(app);

// REMOVED: setLogLevel('debug');

// --- Helper Functions ---
/**
 * Gets today's date in 'YYYY-MM-DD' format
 */
const getTodayString = () => {
    return new Date().toISOString().split('T')[0];
};

/**
 * Formats a timestamp into a readable time
 */
const formatTime = (date) => {
    if (!date) return '';
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
};

// --- App Component ---
export default function App() {
    const [user, setUser] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [error, setError] = useState(null);
    
    // Form state
    const [newTaskTitle, setNewTaskTitle] = useState('');
    const [newTaskTime, setNewTaskTime] = useState('');
    const [newTaskHours, setNewTaskHours] = useState(1);

    // Data state
    const [myTasks, setMyTasks] = useState([]);
    const [allUserStats, setAllUserStats] = useState([]);
    const [currentTime, setCurrentTime] = useState(new Date());
    
    // Paths
    const [userTasksCollectionPath, setUserTasksCollectionPath] = useState(null);
    const [userStatsDocPath, setUserStatsDocPath] = useState(null);
    // Use the appId (from process.env.REACT_APP_PROJECT_ID) in the path
    const publicStatsCollectionPath = `/artifacts/${appId}/public/data/userStats`;

    // --- 1. Authentication Effect ---
    useEffect(() => {
        const authHandler = async (user) => {
            if (user) {
                // User is signed in
                const userId = user.uid;
                const userDisplayName = user.displayName || user.email || 'Anonymous';
                
                // Set user state
                setUser(user);
                
                // Define paths
                const tasksPath = `/artifacts/${appId}/users/${userId}/tasks`;
                const statsPath = `/artifacts/${appId}/public/data/userStats/${userId}`;
                setUserTasksCollectionPath(tasksPath);
                setUserStatsDocPath(statsPath);

                // --- Create user stat document if it doesn't exist ---
                // This is the public data for the chart
                try {
                    const userStatRef = doc(db, statsPath);
                    const docSnap = await getDoc(userStatRef);
                    if (!docSnap.exists()) {
                        console.log(`Creating user stats doc at: ${statsPath}`);
                        await setDoc(userStatRef, {
                            userId: userId,
                            displayName: userDisplayName,
                            tasksCompleted: 0,
                            totalHours: 0,
                        });
                    } else {
                        console.log(`User stats doc already exists at: ${statsPath}`);
                        // Ensure display name is up-to-date
                        await updateDoc(userStatRef, { displayName: userDisplayName });
                    }
                } catch (e) {
                    console.error("Error creating/checking user stat doc:", e);
                    setError("Could not initialize your user profile.");
                }

            } else {
                // User is signed out
                setUser(null);
                setUserTasksCollectionPath(null);
                setUserStatsDocPath(null);
            }
            setIsAuthReady(true);
        };

        // REMOVED: const signIn = async () => { ... }
        // We will let Firebase handle auth state persistence

        // Set up the auth state listener
        const unsubscribe = onAuthStateChanged(auth, authHandler);
        
        // REMOVED: signIn();
        // The listener will fire on its own when the page loads

        // Clean up subscription on unmount
        return () => unsubscribe();
    }, []); // Empty dependency array ensures this runs once on mount

    // --- 2. Real-time Data Fetching Effect ---
    useEffect(() => {
        // Guard: Don't run queries until auth is ready and we have paths
        if (!isAuthReady || !user || !userTasksCollectionPath || !publicStatsCollectionPath) {
            // Clear data on sign out
            setMyTasks([]);
            setAllUserStats([]);
            return;
        }
        
        console.log(`Setting up listeners for user: ${user.uid}`);

        // --- Listener 1: Get *my* private tasks for *today* ---
        const todayStr = getTodayString();
        const tasksQuery = query(
            collection(db, userTasksCollectionPath),
            where("scheduledDate", "==", todayStr)
            // Note: We don't use orderBy("scheduledTime") to avoid needing composite indexes
        );

        const unsubscribeTasks = onSnapshot(tasksQuery, (querySnapshot) => {
            const tasksData = [];
            querySnapshot.forEach((doc) => {
                tasksData.push({ id: doc.id, ...doc.data() });
            });
            // Sort in memory
            tasksData.sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
            setMyTasks(tasksData);
            console.log("Tasks updated:", tasksData);
        }, (e) => {
            console.error("Error listening to tasks:", e);
            setError("Could not load your tasks.");
        });

        // --- Listener 2: Get *all users'* public stats for charts ---
        const statsQuery = query(collection(db, publicStatsCollectionPath));
        
        const unsubscribeStats = onSnapshot(statsQuery, (querySnapshot) => {
            const statsData = [];
            querySnapshot.forEach((doc) => {
                statsData.push({ id: doc.id, ...doc.data() });
            });
            setAllUserStats(statsData);
            console.log("All user stats updated:", statsData);
        }, (e) => {
            console.error("Error listening to user stats:", e);
            setError("Could not load comparison charts.");
        });

        // Cleanup function
        return () => {
            console.log("Cleaning up listeners...");
            unsubscribeTasks();
            unsubscribeStats();
        };

    }, [isAuthReady, user, userTasksCollectionPath, publicStatsCollectionPath]); // Re-run if auth state or paths change

    // --- 3. Current Time Ticker Effect ---
    useEffect(() => {
        // This timer updates the current time every 60 seconds
        // to check which tasks are "active"
        const timerId = setInterval(() => {
            setCurrentTime(new Date());
        }, 60000); // Check every minute
        
        return () => clearInterval(timerId);
    }, []);

    // --- UI Logic: Memoized Task Sorting ---
    const { activeTasks, upcomingTasks, completedTasks } = useMemo(() => {
        const now = currentTime.getTime();
        
        const active = [];
        const upcoming = [];
        const completed = [];

        myTasks.forEach(task => {
            if (task.isComplete) {
                completed.push(task);
            } else {
                const taskTime = new Date(task.scheduledTime).getTime();
                if (taskTime <= now) {
                    active.push(task);
                } else {
                    upcoming.push(task);
                }
            }
        });
        
        return { activeTasks: active, upcomingTasks: upcoming, completedTasks: completed };
    }, [myTasks, currentTime]);

    // --- Event Handlers ---
    
    const handleGoogleSignIn = async () => {
        const provider = new GoogleAuthProvider();
        try {
            setError(null);
            await signInWithPopup(auth, provider);
            // onAuthStateChanged will handle the rest
        } catch (e) {
            console.error("Google Sign-in error:", e);
            setError("Failed to sign in with Google.");
        }
    };

    const handleSignOut = async () => {
        try {
            setError(null);
            await signOut(auth);
            // onAuthStateChanged will handle the sign-out
        } catch (e) {
            console.error("Sign-out error:", e);
            setError("Failed to sign out.");
        }
    };

    const handleAddTask = async (e) => {
        e.preventDefault();
        if (!newTaskTitle || !newTaskTime || !userTasksCollectionPath) {
            setError("Please fill in all fields.");
            return;
        }

        const fullScheduledTime = new Date(newTaskTime);
        const scheduledDate = fullScheduledTime.toISOString().split('T')[0];

        try {
            setError(null);
            console.log(`Adding task to: ${userTasksCollectionPath}`);
            await addDoc(collection(db, userTasksCollectionPath), {
                userId: user.uid,
                title: newTaskTitle,
                scheduledTime: fullScheduledTime.toISOString(),
                scheduledDate: scheduledDate,
                hoursSpent: parseFloat(newTaskHours),
                isComplete: false,
                createdAt: new Date().toISOString(),
            });
            
            // Reset form
            setNewTaskTitle('');
            setNewTaskTime('');
            setNewTaskHours(1);

        } catch (e) {
            console.error("Error adding task:", e);
            setError("Failed to add task.");
        }
    };

    const handleCompleteTask = async (taskId, hours) => {
        if (!userTasksCollectionPath || !userStatsDocPath) return;

        const taskRef = doc(db, userTasksCollectionPath, taskId);
        const statsRef = doc(db, userStatsDocPath);
        
        try {
            setError(null);
            // 1. Update the private task
            await updateDoc(taskRef, {
                isComplete: true
            });

            // 2. Increment the public stats atomically
            await setDoc(statsRef, {
                tasksCompleted: increment(1),
                totalHours: increment(hours)
            }, { merge: true }); // Use setDoc with merge to create/update

        } catch (e) {
            console.error("Error completing task:", e);
            setError("Failed to complete task.");
        }
    };

    // --- Render Loading / Auth State ---
    if (!isAuthReady) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-gray-900 text-white">
                <div className="text-2xl font-medium">Loading...</div>
            </div>
        );
    }
    
    if (!user) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-gray-900 text-white p-4">
                <div className="w-full max-w-md p-8 bg-gray-800 rounded-2xl shadow-xl text-center">
                    <h1 className="text-4xl font-bold text-white mb-4">Task Tracker</h1>
                    <p className="text-lg text-gray-300 mb-8">Sign in to track your progress and compare with friends.</p>
                    <button
                        onClick={handleGoogleSignIn}
                        className="w-full px-4 py-3 bg-indigo-600 text-white rounded-lg font-semibold text-lg hover:bg-indigo-500 transition-colors duration-300 shadow-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-opacity-75"
                    >
                        Sign in with Google
                    </button>
                    {error && <p className="mt-4 text-red-400">{error}</p>}
                </div>
            </div>
        );
    }

    // --- Render Main App ---
    return (
        <div className="min-h-screen bg-gray-900 text-gray-100 p-4 md:p-8">
            <div className="max-w-7xl mx-auto">
                
                {/* --- Header --- */}
                <header className="flex flex-col md:flex-row justify-between items-center mb-8">
                    <h1 className="text-4xl font-bold text-white mb-4 md:mb-0">
                        Welcome, {user.displayName || user.email}
                    </h1>
                    <div>
                        <p className="text-xs text-gray-400 mb-2 text-center md:text-right">Share this ID with your friend!</p>
                        <p className="text-sm bg-gray-800 px-3 py-1 rounded-full text-indigo-300 font-mono mb-2 text-center md:text-right">
                           Your User ID: {user.uid}
                        </p>
                        <button
                            onClick={handleSignOut}
                            className="w-full md:w-auto px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-500 transition-colors duration-300"
                        >
                            Sign Out
                        </button>
                    </div>
                </header>

                {error && (
                    <div className="bg-red-800 border border-red-600 text-red-100 px-4 py-3 rounded-lg relative mb-6" role="alert">
                        <strong className="font-bold">Error: </strong>
                        <span className="block sm:inline">{error}</span>
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    
                    {/* --- Column 1: Add Task & Today's Tasks --- */}
                    <div className="lg:col-span-2 space-y-8">

                        {/* --- Add Task Form --- */}
                        <div className="bg-gray-800 p-6 rounded-2xl shadow-xl">
                            <h2 className="text-2xl font-semibold mb-4 text-white">Add a New Task for Today</h2>
                            <form onSubmit={handleAddTask} className="space-y-4">
                                <div>
                                    <label htmlFor="task-title" className="block text-sm font-medium text-gray-300 mb-1">Task Title</label>
                                    <input
                                        type="text"
                                        id="task-title"
                                        value={newTaskTitle}
                                        onChange={(e) => setNewTaskTitle(e.target.value)}
                                        placeholder="e.g., Read 1 chapter"
                                        className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                    />
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label htmlFor="task-time" className="block text-sm font-medium text-gray-300 mb-1">Start Time</label>
                                        <input
                                            type="datetime-local"
                                            id="task-time"
                                            value={newTaskTime}
                                            onChange={(e) => setNewTaskTime(e.target.value)}
                                            className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                        />
                                    </div>
                                    <div>
                                        <label htmlFor="task-hours" className="block text-sm font-medium text-gray-300 mb-1">Estimated Hours</label>
                                        <input
                                            type="number"
                                            id="task-hours"
                                            value={newTaskHours}
                                            onChange={(e) => setNewTaskHours(parseFloat(e.target.value))}
                                            min="0.1"
                                            step="0.1"
                                            className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                        />
                                    </div>
                                </div>
                                <button
                                    type="submit"
                                    className="w-full px-6 py-3 bg-indigo-600 text-white rounded-lg font-semibold text-lg hover:bg-indigo-500 transition-colors duration-300 shadow-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-opacity-75"
                                >
                                    Add Task
                                </button>
                            </form>
                        </div>

                        {/* --- Task Lists --- */}
                        <div className="bg-gray-800 p-6 rounded-2xl shadow-xl">
                            <h2 className="text-2xl font-semibold mb-4 text-white">Your Tasks for Today ({getTodayString()})</h2>
                            
                            {/* Active Tasks */}
                            <TaskSection 
                                title="Active Tasks" 
                                tasks={activeTasks} 
                                onCompleteTask={handleCompleteTask} 
                                color="bg-red-500" 
                                accent="border-red-500"
                            />
                            
                            {/* Upcoming Tasks */}
                            <TaskSection 
                                title="Upcoming Tasks" 
                                tasks={upcomingTasks} 
                                onCompleteTask={handleCompleteTask} 
                                color="bg-yellow-500"
                                accent="border-yellow-500"
                            />
                            
                            {/* Completed Tasks */}
                            <TaskSection 
                                title="Completed Tasks" 
                                tasks={completedTasks} 
                                onCompleteTask={handleCompleteTask} 
                                color="bg-green-500"
                                accent="border-green-500"
                            />
                            
                            {myTasks.length === 0 && (
                                <p className="text-gray-400">No tasks scheduled for today. Add one above!</p>
                            )}
                        </div>
                    </div>
                    
                    {/* --- Column 2: Comparison Charts --- */}
                    <div className="bg-gray-800 p-6 rounded-2xl shadow-xl">
                        <h2 className="text-2xl font-semibold mb-6 text-white text-center">Productivity Comparison</h2>
                        
                        {/* Chart 1: Tasks Completed */}
                        <div className="mb-8">
                            <h3 className="text-lg font-medium text-gray-200 mb-4 text-center">Tasks Completed</h3>
                            <ResponsiveContainer width="100%" height={300}>
                                <BarChart data={allUserStats} margin={{ top: 5, right: 0, left: 0, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#4B5563" />
                                    <XAxis dataKey="displayName" stroke="#9CA3AF" />
                                    <YAxis stroke="#9CA3AF" allowDecimals={false} />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: '#1F2937', border: 'none', borderRadius: '8px' }}
                                        labelStyle={{ color: '#F3F4F6' }}
                                    />
                                    <Legend />
                                    <Bar dataKey="tasksCompleted" fill="#4F46E5" name="Tasks" />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                        
                        {/* Chart 2: Hours Logged */}
                        <div>
                            <h3 className="text-lg font-medium text-gray-200 mb-4 text-center">Total Hours Logged</h3>
                            <ResponsiveContainer width="100%" height={300}>
                                <BarChart data={allUserStats} margin={{ top: 5, right: 0, left: 0, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#4B5563" />
                                    <XAxis dataKey="displayName" stroke="#9CA3AF" />
                                    <YAxis stroke="#9CA3AF" />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: '#1F2937', border: 'none', borderRadius: '8px' }}
                                        labelStyle={{ color: '#F3F4F6' }}
                                    />
                                    <Legend />
                                    <Bar dataKey="totalHours" fill="#EC4899" name="Hours" />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// --- Sub-component for Task Lists ---
function TaskSection({ title, tasks, onCompleteTask, color, accent }) {
    if (tasks.length === 0) return null;

    return (
        <div className="mb-6">
            <h3 className={`text-xl font-semibold mb-3 text-gray-200 flex items-center`}>
                <span className={`w-3 h-3 ${color} rounded-full mr-3`}></span>
                {title}
            </h3>
            <div className="space-y-3">
                {tasks.map(task => (
                    <TaskItem 
                        key={task.id} 
                        task={task} 
                        onCompleteTask={onCompleteTask}
                        accent={accent}
                    />
                ))}
            </div>
        </div>
    );
}

// --- Sub-component for a single Task ---
function TaskItem({ task, onCompleteTask, accent }) {
    const startTime = formatTime(new Date(task.scheduledTime));
    
    return (
        <div className={`flex flex-col md:flex-row items-center justify-between p-4 bg-gray-700 rounded-lg border-l-4 ${task.isComplete ? 'border-green-500 opacity-60' : accent}`}>
            <div className="mb-2 md:mb-0">
                <p className="text-lg font-medium text-white">{task.title}</p>
                <p className="text-sm text-gray-300">
                    Starts at: {startTime} | Estimated: {task.hoursSpent} hr(s)
                </p>
            </div>
            {!task.isComplete && (
                <button
                    onClick={() => onCompleteTask(task.id, task.hoursSpent)}
                    className="w-full md:w-auto px-4 py-2 bg-green-600 text-white rounded-lg font-semibold text-sm hover:bg-green-500 transition-colors duration-300"
                >
                    Mark as Complete
                </button>
            )}
        </div>
    );
}