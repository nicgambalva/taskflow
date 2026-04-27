import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCg_O9-fAv64x4w3PspxicX6sqBSG4uoTI",
  authDomain: "taskflow-db557.firebaseapp.com",
  projectId: "taskflow-db557",
  storageBucket: "taskflow-db557.firebasestorage.app",
  messagingSenderId: "753353252618",
  appId: "1:753353252618:web:651785714089c53bc2e4f3"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
