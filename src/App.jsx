import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc
} from "firebase/firestore";

const USERS = ["— Unassigned —", "Matthieu", "Tétiana", "Melvyn", "Nicolas", "Ksenia", "Sudhir", "Lilia", "Shamir"];
const DAYS  = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_INDEX = { Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6, Sunday:0 };

function isOverdue(deadline, validated) {
  if (validated || !deadline) return false;
  return new Date() > new Date(deadline);
}

function formatDeadline(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

function getNextReset(task) {
  const now = new Date();
  if (task.recurringDaily) {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
    return next.toISOString();
  }
  if (task.recurringWeekly) {
    const [h, m] = (task.weeklyTime || "09:00").split(":").map(Number);
    const targetDay = DAY_INDEX[task.weeklyDay] ?? 1;
    const next = new Date(now);
    let daysAhead = (targetDay - now.getDay() + 7) % 7;
    if (daysAhead === 0) {
      const todayTarget = new Date(now);
      todayTarget.setHours(h, m, 0, 0);
      if (now >= todayTarget) daysAhead = 7;
    }
    if (daysAhead === 0) daysAhead = 7;
    next.setDate(next.getDate() + daysAhead);
    next.setHours(h, m, 0, 0);
    return next.toISOString();
  }
  return null;
}

function formatNextReset(iso) {
  if (!iso) return "";
  const diffMs = new Date(iso) - new Date();
  const diffH = Math.floor(diffMs / 3600000);
  const diffD = Math.floor(diffMs / 86400000);
  if (diffH < 24) return `in ${diffH}h`;
  return `in ${diffD}d`;
}

const emptyForm = {
  name: "", assignee: "— Unassigned —", deadline: "",
  fileName: null, fileData: null,
  recurringDaily: false, recurringWeekly: false, weeklyDay: "Monday", weeklyTime: "09:00",
};

function DailyBadge({ nextReset }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#1a2535", border: "1px solid #3b5bdb44", color: "#74b0ff", fontSize: 10, padding: "2px 8px", borderRadius: 20, letterSpacing: "0.06em" }}>↻ Daily</span>
      {nextReset && <span style={{ fontSize: 9, color: "#3b5bdb", letterSpacing: "0.04em" }}>{formatNextReset(nextReset)}</span>}
    </div>
  );
}

function WeeklyBadge({ day, time, nextReset }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#1e1a35", border: "1px solid #7c3aed44", color: "#c8b8ff", fontSize: 10, padding: "2px 8px", borderRadius: 20, letterSpacing: "0.06em" }}>↻ {day} {time}</span>
      {nextReset && <span style={{ fontSize: 9, color: "#7c3aed", letterSpacing: "0.04em" }}>{formatNextReset(nextReset)}</span>}
    </div>
  );
}

function Toggle({ checked, onChange, color = "#7c3aed" }) {
  return (
    <div onClick={onChange} style={{ cursor: "pointer", width: 36, height: 20, borderRadius: 10, background: checked ? color : "#2a2a42", transition: "background 0.2s", position: "relative", flexShrink: 0 }}>
      <div style={{ position: "absolute", top: 3, left: checked ? 18 : 3, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 4px #0008" }} />
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 22, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 10, color: "#6b6b9a", letterSpacing: "0.1em", marginTop: 2 }}>{label}</div>
    </div>
  );
}

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [previewFile, setPreviewFile] = useState(null);
  const fileRef = useRef();

  // Real-time listener from Firestore
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "tasks"), snapshot => {
      const data = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setTasks(data);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  // Recurring reset check
  useEffect(() => {
    async function checkResets() {
      const now = new Date();
      for (const task of tasks) {
        if (!task.validated) continue;
        if (!task.recurringDaily && !task.recurringWeekly) continue;

        let shouldReset = false;

        if (task.recurringDaily) {
          const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
          const validatedAt = task.validatedAt ? new Date(task.validatedAt) : null;
          if (validatedAt && validatedAt < midnight) shouldReset = true;
        }

        if (task.recurringWeekly) {
          const [h, m] = (task.weeklyTime || "09:00").split(":").map(Number);
          const targetDay = DAY_INDEX[task.weeklyDay] ?? 1;
          const lastOccurrence = new Date(now);
          let daysBack = (now.getDay() - targetDay + 7) % 7;
          if (daysBack === 0) {
            const todayTarget = new Date(now); todayTarget.setHours(h, m, 0, 0);
            if (now < todayTarget) daysBack = 7;
          }
          lastOccurrence.setDate(lastOccurrence.getDate() - daysBack);
          lastOccurrence.setHours(h, m, 0, 0);
          const validatedAt = task.validatedAt ? new Date(task.validatedAt) : null;
          if (validatedAt && validatedAt < lastOccurrence) shouldReset = true;
        }

        if (shouldReset) {
          await updateDoc(doc(db, "tasks", task.id), {
            validated: false, validatedAt: null, lastReset: now.toISOString()
          });
        }
      }
    }
    if (tasks.length > 0) checkResets();
    const t = setInterval(checkResets, 30000);
    return () => clearInterval(t);
  }, [tasks]);

  const sorted = [...tasks].sort((a, b) => {
    if (a.validated !== b.validated) return a.validated ? 1 : -1;
    if (!a.deadline) return 1; if (!b.deadline) return -1;
    return new Date(a.deadline) - new Date(b.deadline);
  });

  function openAdd() { setForm(emptyForm); setModal({ mode: "add" }); }

  function openEdit(task) {
    setForm({
      name: task.name, assignee: task.assignee,
      deadline: task.deadline ? task.deadline.slice(0, 16) : "",
      fileName: task.fileName, fileData: task.fileData,
      recurringDaily: task.recurringDaily || false,
      recurringWeekly: task.recurringWeekly || false,
      weeklyDay: task.weeklyDay || "Monday",
      weeklyTime: task.weeklyTime || "09:00",
    });
    setModal({ mode: "edit", task });
  }

  function handleFile(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setForm(f => ({ ...f, fileName: file.name, fileData: ev.target.result }));
    reader.readAsDataURL(file);
  }

  async function saveForm() {
    if (!form.name.trim()) return;
    const deadline = form.deadline ? new Date(form.deadline).toISOString() : null;
    const rec = {
      recurringDaily: form.recurringDaily, recurringWeekly: form.recurringWeekly,
      weeklyDay: form.weeklyDay, weeklyTime: form.weeklyTime
    };
    const payload = {
      name: form.name.trim(), assignee: form.assignee, deadline,
      fileName: form.fileName || null, fileData: form.fileData || null, ...rec
    };
    if (modal.mode === "add") {
      await addDoc(collection(db, "tasks"), {
        ...payload, validated: false, validatedAt: null,
        createdAt: new Date().toISOString(), lastReset: null
      });
    } else {
      await updateDoc(doc(db, "tasks", modal.task.id), payload);
    }
    setModal(null);
  }

  async function validate(task) {
    const newVal = !task.validated;
    await updateDoc(doc(db, "tasks", task.id), {
      validated: newVal,
      validatedAt: newVal ? new Date().toISOString() : null
    });
  }

  async function deleteTask(id) {
    await deleteDoc(doc(db, "tasks", id));
  }

  const overdueCount = tasks.filter(t => isOverdue(t.deadline, t.validated)).length;
  const doneCount = tasks.filter(t => t.validated).length;
  const recurringCount = tasks.filter(t => t.recurringDaily || t.recurringWeekly).length;

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logoMark}>✦</div>
          <div>
            <div style={styles.title}>TaskFlow</div>
            <div style={styles.subtitle}>Shared collaborative workspace</div>
          </div>
        </div>
        <div style={styles.stats}>
          <Stat label="Total" value={tasks.length} color="#c8b8ff" />
          <Stat label="Done" value={doneCount} color="#6ee7b7" />
          <Stat label="Overdue" value={overdueCount} color="#fca5a5" />
          <Stat label="Recurring" value={recurringCount} color="#74b0ff" />
        </div>
      </header>

      <main style={styles.main}>
        {loading ? (
          <div style={styles.empty}>Connecting to database...</div>
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {["#", "Task", "Assigned to", "Deadline", "↻ Daily", "↻ Weekly", "Document", "Status", "Actions"].map(h => (
                    <th key={h} style={styles.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 && <tr><td colSpan={9} style={styles.empty}>No tasks yet. Add one!</td></tr>}
                {sorted.map((task, i) => {
                  const overdue = isOverdue(task.deadline, task.validated);
                  const nextReset = (task.recurringDaily || task.recurringWeekly) ? getNextReset(task) : null;
                  return (
                    <tr key={task.id} style={{ ...styles.tr, ...(task.validated ? styles.trDone : {}), ...(overdue ? styles.trOverdue : {}), animation: overdue ? "blink 1.2s ease-in-out infinite" : "none" }}>
                      <td style={styles.td}><span style={styles.idx}>{i + 1}</span></td>
                      <td style={{ ...styles.td, ...styles.tdName }}>
                        {task.validated && <span style={styles.check}>✓ </span>}
                        <span style={task.validated ? styles.striked : {}}>{task.name}</span>
                        {task.lastReset && <div style={styles.resetNote}>↺ auto-reopened</div>}
                      </td>
                      <td style={styles.td}>
                        <span style={styles.assignee}>{task.assignee === "— Unassigned —" ? <em style={{ opacity: 0.5 }}>—</em> : task.assignee}</span>
                      </td>
                      <td style={styles.td}>
                        <span style={{ ...styles.deadline, ...(overdue ? styles.deadlineRed : {}) }}>
                          {formatDeadline(task.deadline)}
                          {overdue && <span style={styles.badge}>OVERDUE</span>}
                        </span>
                      </td>
                      <td style={{ ...styles.td, textAlign: "center" }}>
                        {task.recurringDaily ? <DailyBadge nextReset={task.validated ? nextReset : null} /> : <span style={{ opacity: 0.2, fontSize: 11 }}>—</span>}
                      </td>
                      <td style={{ ...styles.td, textAlign: "center" }}>
                        {task.recurringWeekly ? <WeeklyBadge day={task.weeklyDay} time={task.weeklyTime} nextReset={task.validated ? nextReset : null} /> : <span style={{ opacity: 0.2, fontSize: 11 }}>—</span>}
                      </td>
                      <td style={styles.td}>
                        {task.fileData ? <button style={styles.fileBtn} onClick={() => setPreviewFile(task)}>📎 {task.fileName?.length > 14 ? task.fileName.slice(0, 12) + "…" : task.fileName}</button> : <span style={{ opacity: 0.3 }}>—</span>}
                      </td>
                      <td style={styles.td}>
                        <button style={{ ...styles.validateBtn, ...(task.validated ? styles.validateBtnDone : {}) }} onClick={() => validate(task)}>
                          {task.validated ? "✓ Done" : "Mark done"}
                        </button>
                      </td>
                      <td style={styles.td}>
                        <div style={styles.actions}>
                          <button style={styles.iconBtn} title="Edit" onClick={() => openEdit(task)}>✎</button>
                          <button style={{ ...styles.iconBtn, ...styles.iconBtnRed }} title="Delete" onClick={() => deleteTask(task.id)}>✕</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <button style={styles.addBtn} onClick={openAdd}>+ Add task</button>
      </main>

      {modal && (
        <div style={styles.overlay} onClick={() => setModal(null)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <div style={styles.modalTitle}>{modal.mode === "add" ? "New task" : "Edit task"}</div>

            <label style={styles.label}>Task name *</label>
            <input style={styles.input} placeholder="e.g. Prepare the report..." value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />

            <label style={styles.label}>Assigned to</label>
            <select style={styles.input} value={form.assignee} onChange={e => setForm(f => ({ ...f, assignee: e.target.value }))}>
              {USERS.map(u => <option key={u}>{u}</option>)}
            </select>

            <label style={styles.label}>Deadline</label>
            <input type="datetime-local" style={styles.input} value={form.deadline} onChange={e => setForm(f => ({ ...f, deadline: e.target.value }))} />

            <div style={styles.recurringRow}>
              <div style={{ flex: 1 }}>
                <div style={styles.recurringLabel}>↻ Recurring daily</div>
                <div style={styles.recurringDesc}>Reopens automatically every day at midnight</div>
              </div>
              <Toggle checked={form.recurringDaily} onChange={() => setForm(f => ({ ...f, recurringDaily: !f.recurringDaily, recurringWeekly: !f.recurringDaily ? false : f.recurringWeekly }))} color="#3b5bdb" />
            </div>

            <div style={styles.recurringRow}>
              <div style={{ flex: 1 }}>
                <div style={styles.recurringLabel}>↻ Recurring weekly</div>
                <div style={styles.recurringDesc}>Reopens automatically once a week</div>
              </div>
              <Toggle checked={form.recurringWeekly} onChange={() => setForm(f => ({ ...f, recurringWeekly: !f.recurringWeekly, recurringDaily: !f.recurringWeekly ? false : f.recurringDaily }))} color="#7c3aed" />
            </div>

            {form.recurringWeekly && (
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={styles.label}>Day</label>
                  <select style={styles.input} value={form.weeklyDay} onChange={e => setForm(f => ({ ...f, weeklyDay: e.target.value }))}>
                    {DAYS.map(d => <option key={d}>{d}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={styles.label}>Time</label>
                  <input type="time" style={styles.input} value={form.weeklyTime} onChange={e => setForm(f => ({ ...f, weeklyTime: e.target.value }))} />
                </div>
              </div>
            )}

            <label style={styles.label}>Document (procedure, PDF…)</label>
            <div style={styles.fileRow}>
              <input ref={fileRef} type="file" style={{ display: "none" }} onChange={handleFile} />
              <button style={styles.fileUploadBtn} onClick={() => fileRef.current.click()}>
                📎 {form.fileName ? form.fileName : "Choose a file"}
              </button>
              {form.fileName && <button style={styles.removeFile} onClick={() => setForm(f => ({ ...f, fileName: null, fileData: null }))}>✕</button>}
            </div>

            <div style={styles.modalBtns}>
              <button style={styles.cancelBtn} onClick={() => setModal(null)}>Cancel</button>
              <button style={styles.saveBtn} onClick={saveForm}>{modal.mode === "add" ? "Add task" : "Save"}</button>
            </div>
          </div>
        </div>
      )}

      {previewFile && (
        <div style={styles.overlay} onClick={() => setPreviewFile(null)}>
          <div style={{ ...styles.modal, maxWidth: 640 }} onClick={e => e.stopPropagation()}>
            <div style={styles.modalTitle}>📎 {previewFile.fileName}</div>
            {previewFile.fileData?.startsWith("data:image") ? <img src={previewFile.fileData} alt="preview" style={{ width: "100%", borderRadius: 8 }} />
              : previewFile.fileData?.startsWith("data:application/pdf") ? <iframe src={previewFile.fileData} style={{ width: "100%", height: 400, border: "none", borderRadius: 8 }} title="pdf" />
              : <p style={{ color: "#c8b8ff" }}>Preview not available for this file type.</p>}
            <div style={styles.modalBtns}>
              <a href={previewFile.fileData} download={previewFile.fileName} style={styles.saveBtn}>⬇ Download</a>
              <button style={styles.cancelBtn} onClick={() => setPreviewFile(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700;800&display=swap');
        @keyframes blink { 0%,100%{background:rgba(239,68,68,0.13)} 50%{background:rgba(239,68,68,0.32)} }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0d0d14; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #1a1a2e; }
        ::-webkit-scrollbar-thumb { background: #3d3d6b; border-radius: 3px; }
        select option { background: #13131f; color: #e8e4ff; }
      `}</style>
    </div>
  );
}

const styles = {
  root: { minHeight: "100vh", background: "#0d0d14", fontFamily: "'DM Mono', monospace", color: "#e8e4ff" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "28px 40px 20px", borderBottom: "1px solid #2a2a42", flexWrap: "wrap", gap: 16 },
  headerLeft: { display: "flex", alignItems: "center", gap: 16 },
  logoMark: { fontSize: 32, color: "#c8b8ff", lineHeight: 1, textShadow: "0 0 20px #c8b8ff88" },
  title: { fontFamily: "'Syne', sans-serif", fontSize: 26, fontWeight: 800, color: "#fff", letterSpacing: "-0.5px" },
  subtitle: { fontSize: 11, color: "#6b6b9a", letterSpacing: "0.08em", marginTop: 2 },
  stats: { display: "flex", gap: 24 },
  main: { padding: "28px 40px 60px" },
  tableWrap: { overflowX: "auto", borderRadius: 12, border: "1px solid #2a2a42" },
  table: { width: "100%", borderCollapse: "collapse", minWidth: 960 },
  th: { padding: "14px 16px", textAlign: "left", fontSize: 10, letterSpacing: "0.12em", color: "#6b6b9a", background: "#13131f", borderBottom: "1px solid #2a2a42", fontWeight: 500, textTransform: "uppercase", whiteSpace: "nowrap" },
  tr: { borderBottom: "1px solid #1e1e30", transition: "background 0.2s" },
  trDone: { opacity: 0.45 },
  trOverdue: { borderLeft: "3px solid #ef4444" },
  td: { padding: "14px 16px", fontSize: 13, verticalAlign: "middle" },
  tdName: { fontWeight: 500, maxWidth: 200 },
  idx: { color: "#3d3d6b", fontSize: 11 },
  check: { color: "#6ee7b7" },
  striked: { textDecoration: "line-through", opacity: 0.6 },
  resetNote: { fontSize: 9, color: "#7c3aed", letterSpacing: "0.06em", marginTop: 3 },
  assignee: { background: "#1e1e35", padding: "3px 10px", borderRadius: 20, fontSize: 12, color: "#c8b8ff" },
  deadline: { fontSize: 12, color: "#a0a0c0" },
  deadlineRed: { color: "#fca5a5" },
  badge: { display: "inline-block", marginLeft: 8, background: "#ef444422", color: "#fca5a5", fontSize: 9, letterSpacing: "0.1em", padding: "2px 7px", borderRadius: 4, border: "1px solid #ef444444" },
  fileBtn: { background: "none", border: "1px solid #3a3a5c", color: "#c8b8ff", borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" },
  validateBtn: { background: "#1e1e35", border: "1px solid #3a3a5c", color: "#a0a0c0", borderRadius: 6, padding: "5px 14px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", transition: "all 0.2s" },
  validateBtnDone: { background: "#162b22", border: "1px solid #6ee7b766", color: "#6ee7b7" },
  actions: { display: "flex", gap: 6 },
  iconBtn: { background: "#1e1e35", border: "1px solid #3a3a5c", color: "#c8b8ff", borderRadius: 6, width: 30, height: 30, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" },
  iconBtnRed: { color: "#fca5a5", borderColor: "#ef444444" },
  addBtn: { marginTop: 20, background: "linear-gradient(135deg, #7c3aed, #4f46e5)", color: "#fff", border: "none", borderRadius: 8, padding: "12px 28px", fontSize: 13, cursor: "pointer", fontFamily: "inherit", fontWeight: 500, letterSpacing: "0.04em", boxShadow: "0 4px 20px #7c3aed44" },
  empty: { textAlign: "center", padding: 48, color: "#3d3d6b", fontSize: 14 },
  overlay: { position: "fixed", inset: 0, background: "rgba(5,5,12,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20, backdropFilter: "blur(4px)" },
  modal: { background: "#13131f", border: "1px solid #2a2a42", borderRadius: 14, padding: 32, width: "100%", maxWidth: 480, display: "flex", flexDirection: "column", gap: 12 },
  modalTitle: { fontFamily: "'Syne', sans-serif", fontSize: 20, fontWeight: 800, color: "#fff", marginBottom: 8 },
  label: { fontSize: 10, letterSpacing: "0.12em", color: "#6b6b9a", textTransform: "uppercase" },
  input: { background: "#0d0d14", border: "1px solid #2a2a42", borderRadius: 8, padding: "10px 14px", color: "#e8e4ff", fontSize: 13, fontFamily: "inherit", outline: "none", width: "100%", colorScheme: "dark" },
  recurringRow: { display: "flex", alignItems: "center", gap: 12, background: "#0d0d14", border: "1px solid #2a2a42", borderRadius: 8, padding: "12px 14px" },
  recurringLabel: { fontSize: 12, color: "#e8e4ff", fontWeight: 500, marginBottom: 2 },
  recurringDesc: { fontSize: 10, color: "#6b6b9a" },
  fileRow: { display: "flex", gap: 8, alignItems: "center" },
  fileUploadBtn: { background: "#1e1e35", border: "1px solid #3a3a5c", color: "#c8b8ff", borderRadius: 8, padding: "9px 16px", fontSize: 12, cursor: "pointer", fontFamily: "inherit", flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  removeFile: { background: "none", border: "1px solid #ef444444", color: "#fca5a5", borderRadius: 6, width: 32, height: 32, cursor: "pointer", fontSize: 14, fontFamily: "inherit", flexShrink: 0 },
  modalBtns: { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 },
  cancelBtn: { background: "none", border: "1px solid #2a2a42", color: "#6b6b9a", borderRadius: 8, padding: "10px 20px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" },
  saveBtn: { background: "linear-gradient(135deg, #7c3aed, #4f46e5)", border: "none", color: "#fff", borderRadius: 8, padding: "10px 24px", fontSize: 13, cursor: "pointer", fontFamily: "inherit", fontWeight: 500, textDecoration: "none", display: "inline-flex", alignItems: "center" },
};
