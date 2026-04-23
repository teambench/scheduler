// ─── Firebase config ─────────────────────────────────────────────────────
// `apiKey` is replaced at deploy time by .github/workflows/deploy.yml from
// the `FIREBASE_API` repository secret. The other fields are public
// identifiers (safe to commit).
//
// To reuse the same Firebase project as teambench/human-eval, the config
// below already points at `ivory-plane-406700`. For a different project,
// overwrite these values from Firebase Console → Project settings →
// General → Your apps (Web) → SDK setup and configuration.
//
// The scheduler writes only under `scheduler/` — it does not touch the
// `teambench/` paths used by the human-eval app.

export const firebaseConfig = {
  apiKey: "__FIREBASE_API__",
  authDomain: "ivory-plane-406700.firebaseapp.com",
  databaseURL: "https://ivory-plane-406700-default-rtdb.firebaseio.com",
  projectId: "ivory-plane-406700",
  storageBucket: "ivory-plane-406700.firebasestorage.app",
  messagingSenderId: "360125182471",
  appId: "1:360125182471:web:a50fde959d1b09936530a2",
};
