import { useState } from "react";

// ← Change le mot de passe ici
const APP_PASSWORD = "monmotdepasse";

export default function Login({ onLogin }) {
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    if (password === APP_PASSWORD) {
      onLogin();
    } else {
      setError("Mot de passe incorrect.");
      setPassword("");
    }
  }

  return (
    <div style={S.root}>
      <div style={S.card}>
        <div style={S.logo}>✦</div>
        <div style={S.title}>TaskFlow</div>
        <div style={S.subtitle}>Entrez le mot de passe pour accéder à l'application</div>

        <form onSubmit={handleSubmit} style={S.form}>
          <div style={S.field}>
            <label style={S.label}>Mot de passe</label>
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              style={S.input}
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>

          {error && <div style={S.error}>{error}</div>}

          <button
            type="submit"
            disabled={!password}
            style={{...S.btn, ...(!password ? S.btnDisabled : {})}}
          >
            Se connecter
          </button>
        </form>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Syne:wght@700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:#0d0d14}
      `}</style>
    </div>
  );
}

const S = {
  root: {
    minHeight: "100vh",
    background: "#0d0d14",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'Inter', sans-serif",
    padding: 20,
  },
  card: {
    background: "#13131f",
    border: "1px solid #2a2a42",
    borderRadius: 16,
    padding: "40px 36px",
    width: "100%",
    maxWidth: 400,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    boxShadow: "0 24px 64px #00000066",
  },
  logo: {
    fontSize: 36,
    color: "#c8b8ff",
    textShadow: "0 0 24px #c8b8ff88",
    marginBottom: 4,
  },
  title: {
    fontFamily: "'Syne', sans-serif",
    fontSize: 28,
    fontWeight: 800,
    color: "#fff",
    letterSpacing: "-0.5px",
  },
  subtitle: {
    fontSize: 12,
    color: "#6b6b9a",
    letterSpacing: "0.04em",
    marginBottom: 16,
    textAlign: "center",
  },
  form: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  label: {
    fontSize: 10,
    letterSpacing: "0.12em",
    color: "#6b6b9a",
    textTransform: "uppercase",
  },
  input: {
    background: "#0d0d14",
    border: "1px solid #2a2a42",
    borderRadius: 8,
    padding: "11px 14px",
    color: "#e8e4ff",
    fontSize: 14,
    fontFamily: "inherit",
    outline: "none",
    width: "100%",
    transition: "border-color 0.2s",
  },
  error: {
    background: "#ef444411",
    border: "1px solid #ef444433",
    borderRadius: 8,
    padding: "10px 14px",
    color: "#fca5a5",
    fontSize: 13,
  },
  btn: {
    background: "linear-gradient(135deg, #7c3aed, #4f46e5)",
    border: "none",
    borderRadius: 8,
    padding: "12px",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: "pointer",
    marginTop: 4,
    boxShadow: "0 4px 20px #7c3aed44",
    transition: "opacity 0.2s",
  },
  btnDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
  },
};
