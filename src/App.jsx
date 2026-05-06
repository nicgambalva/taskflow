import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, query, orderBy
} from "firebase/firestore";

// ─── SHIFT OPTIONS ────────────────────────────────────────────────────────────
const SHIFT_OPTIONS = [
  { value: "",      label: "— No shift —", color: "#6b6b9a", bg: "transparent" },
  { value: "early", label: "Early",        color: "#74b0ff", bg: "#1a2535" },
  { value: "mid",   label: "Mid",          color: "#6ee7b7", bg: "#162b22" },
  { value: "late",  label: "Late",         color: "#f9a8d4", bg: "#2b1a25" },
];
function shiftCfg(val) { return SHIFT_OPTIONS.find(s => s.value === val) || SHIFT_OPTIONS[0]; }

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const TASK_TYPES = ["Call", "Review", "Approval", "Meeting", "Report", "Training", "Maintenance", "Follow-up", "Other"];
const DAYS  = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const DAY_INDEX = { Monday:1,Tuesday:2,Wednesday:3,Thursday:4,Friday:5,Saturday:6,Sunday:0 };
const UNASSIGNED = "— Unassigned —";

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function isOverdue(deadline, validated) {
  if (validated || !deadline) return false;
  return new Date() > new Date(deadline);
}
function formatDeadline(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB",{ day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit" });
}
function toDateStr(iso) {
  if (!iso) return "";
  return new Date(iso).toISOString().slice(0,10);
}
function isToday(iso) {
  return !!iso && toDateStr(iso) === toDateStr(new Date().toISOString());
}
function addDays(iso, n) {
  const d = iso ? new Date(iso) : new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}
function recurringOccursOn(task, dateStr) {
  if (!dateStr) return false;
  if (task.recurringStart && dateStr < task.recurringStart) return false;
  if (task.recurringEnd   && dateStr > task.recurringEnd)   return false;
  const d = new Date(dateStr + "T12:00:00");
  if (task.recurringDaily) return true;
  if (task.recurringWeekly) return d.getDay() === (DAY_INDEX[task.weeklyDay] ?? 1);
  if (task.recurringAnnually && task.deadline) {
    const dl = new Date(task.deadline);
    return d.getMonth() === dl.getMonth() && d.getDate() === dl.getDate();
  }
  return false;
}
function getNextReset(task) {
  const now = new Date();
  if (task.recurringDaily) {
    const next = new Date(now); next.setDate(next.getDate()+1); next.setHours(0,0,0,0);
    return next.toISOString();
  }
  if (task.recurringWeekly) {
    const [h,m] = (task.weeklyTime||"09:00").split(":").map(Number);
    const targetDay = DAY_INDEX[task.weeklyDay]??1;
    const next = new Date(now);
    let daysAhead = (targetDay-now.getDay()+7)%7;
    if (daysAhead===0){ const tt=new Date(now); tt.setHours(h,m,0,0); if(now>=tt) daysAhead=7; }
    if (daysAhead===0) daysAhead=7;
    next.setDate(next.getDate()+daysAhead); next.setHours(h,m,0,0);
    return next.toISOString();
  }
  if (task.recurringAnnually && task.deadline) {
    const dl = new Date(task.deadline);
    const candidate = new Date(now.getFullYear(), dl.getMonth(), dl.getDate(), 0, 0, 0);
    if (now >= candidate) candidate.setFullYear(candidate.getFullYear() + 1);
    return candidate.toISOString();
  }
  return null;
}
function formatNextReset(iso) {
  if (!iso) return "";
  const diffMs = new Date(iso)-new Date();
  const diffH = Math.floor(diffMs/3600000);
  const diffD = Math.floor(diffMs/86400000);
  return diffH<24?`in ${diffH}h`:`in ${diffD}d`;
}

function toLocalDatetime(iso) {
  if (!iso) return { date:"", time:"" };
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const time = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  return { date, time };
}
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// ─── CSV EXPORT ───────────────────────────────────────────────────────────────
function exportToCSV(tasks) {
  const headers = ["Task","Assigned To","Type","Deadline","Shift","Comment","Status"];
  const rows = tasks.map(t=>[
    t.name, t.assignee||"", t.type||"",
    t.deadline?formatDeadline(t.deadline):"",
    t.shift||"",
    (t.comment||"").replace(/,/g,";"),
    t.validated?"Done":isOverdue(t.deadline,t.validated)?"Overdue":"Pending",
  ]);
  const csv=[headers,...rows].map(r=>r.map(v=>`"${v}"`).join(",")).join("\n");
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url;
  a.download=`taskflow-${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}


// ─── DATE PICKER INPUT ────────────────────────────────────────────────────────
function DatePickerInput({ value, onChange, min, hasError, compact }) {
  const pickerRef = useRef();
  const toDisplay = (v) => v ? `${v.slice(8,10)}/${v.slice(5,7)}/${v.slice(0,4)}` : "";
  const [text, setText] = useState(() => toDisplay(value));

  useEffect(() => { setText(toDisplay(value)); }, [value]);

  const handleChange = (e) => {
    const raw = e.target.value;
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    let formatted = digits;
    if (digits.length > 2) formatted = `${digits.slice(0,2)}/${digits.slice(2)}`;
    if (digits.length > 4) formatted = `${digits.slice(0,2)}/${digits.slice(2,4)}/${digits.slice(4)}`;
    setText(formatted);
    const m = formatted.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) onChange(`${m[3]}-${m[2]}-${m[1]}`);
    else if (!formatted) onChange("");
  };

  const pad   = compact ? "7px 10px" : "10px 14px";
  const fs    = compact ? 12 : 13;
  const border = hasError ? "1px solid #ef444488" : "1px solid #2a2a42";

  return (
    <div style={{display:"flex", gap:4, alignItems:"center"}}>
      <input
        type="text"
        placeholder="dd/mm/yyyy"
        value={text}
        onChange={handleChange}
        style={{flex:1, background:"#0d0d14", border, borderRadius:8, padding:pad, color:"#e8e4ff", fontSize:fs, fontFamily:"inherit", outline:"none", minWidth:compact?100:120}}
      />
      <div style={{position:"relative", flexShrink:0}}>
        <button type="button" style={{background:"#1e1e35", border:"1px solid #3a3a5c", color:"#c8b8ff", borderRadius:8, padding:pad, fontSize:fs, cursor:"pointer", fontFamily:"inherit"}}>📅</button>
        <input
          ref={pickerRef}
          type="date"
          value={value || ""}
          min={min || ""}
          onChange={e => { onChange(e.target.value); setText(toDisplay(e.target.value)); }}
          style={{position:"absolute", inset:0, opacity:0, cursor:"pointer", width:"100%", height:"100%"}}
          tabIndex={-1}
        />
      </div>
    </div>
  );
}

// ─── INLINE SELECT (reusable — fixes the blur-before-change race) ─────────────
function InlineSelect({ value, options, onPick, renderTrigger }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <span style={{cursor:"pointer"}} onClick={() => setOpen(true)}>
        {renderTrigger(value)}
      </span>
    );
  }

  return (
    <div style={{position:"relative", display:"inline-block"}}>
      <select
        autoFocus
        size={options.length}
        style={{
          position:"absolute", top:0, left:0, zIndex:999,
          background:"#13131f", border:"1px solid #3a3a5c",
          color:"#e8e4ff", borderRadius:8, padding:"4px 0",
          fontFamily:"inherit", fontSize:12, outline:"none",
          minWidth:140, cursor:"pointer",
        }}
        value={value}
        onChange={e => { onPick(e.target.value); setOpen(false); }}
        onBlur={() => setOpen(false)}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <span style={{visibility:"hidden"}}>{renderTrigger(value)}</span>
    </div>
  );
}

// ─── INLINE ASSIGNEE ──────────────────────────────────────────────────────────
function InlineAssignee({ task, onUpdate, users }) {
  const userOptions = users.map(u => ({ value: u, label: u }));
  return (
    <InlineSelect
      value={task.assignee || UNASSIGNED}
      options={userOptions}
      onPick={val => onUpdate(task.id, { assignee: val })}
      renderTrigger={val => (
        <span style={{...S.assignee}}>
          {val === UNASSIGNED ? <em style={{opacity:0.5}}>—</em> : val}
        </span>
      )}
    />
  );
}

// ─── INLINE SHIFT ─────────────────────────────────────────────────────────────
function InlineShift({ task, onUpdate }) {
  return (
    <InlineSelect
      value={task.shift || ""}
      options={SHIFT_OPTIONS}
      onPick={val => onUpdate(task.id, { shift: val })}
      renderTrigger={val => {
        const cfg = shiftCfg(val);
        if (!val) return <span style={{opacity:0.2,fontSize:11,cursor:"pointer"}}>— set —</span>;
        return (
          <span style={{display:"inline-flex",alignItems:"center",background:cfg.bg,border:`1px solid ${cfg.color}44`,color:cfg.color,fontSize:10,padding:"2px 8px",borderRadius:20,letterSpacing:"0.06em",cursor:"pointer"}}>
            {cfg.label}
          </span>
        );
      }}
    />
  );
}

// ─── SMALL COMPONENTS ─────────────────────────────────────────────────────────
function DailyBadge({ nextReset }) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
      <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"#1a2535",border:"1px solid #3b5bdb44",color:"#74b0ff",fontSize:10,padding:"2px 8px",borderRadius:20,letterSpacing:"0.06em"}}>↻ Daily</span>
      {nextReset&&<span style={{fontSize:9,color:"#3b5bdb"}}>{formatNextReset(nextReset)}</span>}
    </div>
  );
}
function WeeklyBadge({ day, time, nextReset }) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
      <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"#1e1a35",border:"1px solid #7c3aed44",color:"#c8b8ff",fontSize:10,padding:"2px 8px",borderRadius:20,letterSpacing:"0.06em"}}>↻ {day} {time}</span>
      {nextReset&&<span style={{fontSize:9,color:"#7c3aed"}}>{formatNextReset(nextReset)}</span>}
    </div>
  );
}
function AnnualBadge({ nextReset }) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
      <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"#1f2a1a",border:"1px solid #6ee7b744",color:"#6ee7b7",fontSize:10,padding:"2px 8px",borderRadius:20,letterSpacing:"0.06em"}}>↻ Annual</span>
      {nextReset&&<span style={{fontSize:9,color:"#34d399"}}>{formatNextReset(nextReset)}</span>}
    </div>
  );
}
function Toggle({ checked, onChange, color="#7c3aed" }) {
  return (
    <div onClick={onChange} style={{cursor:"pointer",width:36,height:20,borderRadius:10,background:checked?color:"#2a2a42",transition:"background 0.2s",position:"relative",flexShrink:0}}>
      <div style={{position:"absolute",top:3,left:checked?18:3,width:14,height:14,borderRadius:"50%",background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 4px #0008"}}/>
    </div>
  );
}
function Stat({ label, value, color }) {
  return (
    <div style={{textAlign:"center"}}>
      <div style={{fontFamily:"'Syne',sans-serif",fontSize:22,fontWeight:800,color}}>{value}</div>
      <div style={{fontSize:10,color:"#6b6b9a",letterSpacing:"0.1em",marginTop:2}}>{label}</div>
    </div>
  );
}

// ─── EMPTY FORM ───────────────────────────────────────────────────────────────
const emptyForm = {
  name:"", assignee: UNASSIGNED, deadlineDate:"", deadlineTime:"", type:"", comment:"",
  shift:"", fileName:null, fileData:null,
  recurringDaily:false, recurringWeekly:false, weeklyDay:"Monday", weeklyTime:"09:00",
  recurringAnnually:false, recurringStart:"", recurringEnd:"",
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tasks, setTasks]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [modal, setModal]         = useState(null);
  const [form, setForm]           = useState(emptyForm);
  const [previewFile, setPreviewFile] = useState(null);

  // ── Dynamic users ──
  const [usersData, setUsersData] = useState([]);   // [{id, name}] from Firestore
  const [newUserName, setNewUserName] = useState("");
  const [userError, setUserError] = useState("");
  const [formErrors, setFormErrors] = useState({});
  const users = [UNASSIGNED, ...usersData.map(u => u.name)];

  const [viewMode, setViewMode]       = useState("today");
  const [historyTab, setHistoryTab]   = useState("done");
  const [filterDate, setFilterDate]   = useState("");
  const [filterFrom, setFilterFrom]   = useState("");
  const [filterTo, setFilterTo]       = useState("");
  const [filterType, setFilterType]   = useState("");
  const [filterUser, setFilterUser]   = useState("");
  const [searchName, setSearchName]   = useState("");
  const [history, setHistory]         = useState([]);
  const [expandedHistoryId, setExpandedHistoryId] = useState(null);
  const [deleteConfirmTask, setDeleteConfirmTask] = useState(null);
  const [moveNextDayTask, setMoveNextDayTask]     = useState(null);
  const [historyDeleteConfirm, setHistoryDeleteConfirm] = useState(null);

  const fileRef    = useRef();
  const timeInputRef = useRef();

  // ── Firestore: tasks ──
  useEffect(() => {
    const unsub = onSnapshot(collection(db,"tasks"), snapshot => {
      setTasks(snapshot.docs.map(d => ({ id:d.id, ...d.data() })));
      setLoading(false);
    });
    return () => unsub();
  }, []);

  // ── Firestore: users ──
  useEffect(() => {
    const unsub = onSnapshot(query(collection(db,"users"), orderBy("name")), snapshot => {
      setUsersData(snapshot.docs.map(d => ({ id:d.id, name:d.data().name })));
    });
    return () => unsub();
  }, []);

  // ── Firestore: history ──
  useEffect(() => {
    const unsub = onSnapshot(query(collection(db,"history"), orderBy("at","desc")), snapshot => {
      setHistory(snapshot.docs.map(d => ({ id:d.id, ...d.data() })));
    });
    return () => unsub();
  }, []);

  // ── Recurring task auto-reset ──
  useEffect(() => {
    async function checkResets() {
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
      for (const task of tasks) {
        if (!task.validated) continue;
        if (!task.recurringDaily && !task.recurringWeekly && !task.recurringAnnually) continue;
        if (task.recurringStart && todayStr < task.recurringStart) continue;
        if (task.recurringEnd   && todayStr > task.recurringEnd)   continue;
        let shouldReset = false;
        if (task.recurringDaily) {
          const midnight = new Date(now); midnight.setHours(0,0,0,0);
          const va = task.validatedAt ? new Date(task.validatedAt) : null;
          if (va && va < midnight) shouldReset = true;
        }
        if (task.recurringWeekly) {
          const [h,m] = (task.weeklyTime||"09:00").split(":").map(Number);
          const targetDay = DAY_INDEX[task.weeklyDay]??1;
          const lo = new Date(now);
          let db2 = (now.getDay()-targetDay+7)%7;
          if (db2===0){ const tt=new Date(now); tt.setHours(h,m,0,0); if(now<tt) db2=7; }
          lo.setDate(lo.getDate()-db2); lo.setHours(h,m,0,0);
          const va = task.validatedAt ? new Date(task.validatedAt) : null;
          if (va && va < lo) shouldReset = true;
        }
        if (shouldReset) {
          await updateDoc(doc(db,"tasks",task.id),{ validated:false, validatedAt:null, lastReset:now.toISOString() });
        }
      }
    }
    if (tasks.length>0) checkResets();
    const t = setInterval(checkResets, 30000);
    return () => clearInterval(t);
  }, [tasks]);

  // ── Daily archive at 23:59 ──
  useEffect(() => {
    async function checkDailyArchive() {
      const now = new Date();
      if (now.getHours() !== 23 || now.getMinutes() !== 59) return;
      const todayStr = localToday();
      for (const task of tasks) {
        if (!task.validated) continue;
        if (task.lastArchivedDate === todayStr) continue;
        await addDoc(collection(db,"history"),{
          action:"done", at:now.toISOString(),
          name:task.name, assignee:task.assignee||"", type:task.type||"",
          deadline:task.deadline||null, shift:task.shift||"", comment:task.comment||"",
        });
        await updateDoc(doc(db,"tasks",task.id),{ lastArchivedDate: todayStr });
      }
    }
    if (tasks.length>0) checkDailyArchive();
    const t = setInterval(checkDailyArchive, 60000);
    return () => clearInterval(t);
  }, [tasks]);

  // ── User management ──
  async function addUser() {
    const name = newUserName.trim();
    if (!name) return;
    if (users.includes(name)) {
      setUserError(`"${name}" already exists.`);
      return;
    }
    setUserError("");
    setNewUserName("");
    await addDoc(collection(db,"users"), { name });
  }
  async function deleteUser(id) {
    await deleteDoc(doc(db,"users",id));
    setNewUserName("");
    setUserError("");
  }

  const taskTypes = [...new Set(tasks.map(t=>t.type).filter(Boolean))];

  const filteredTasks = tasks.filter(task => {
    if (searchName && !task.name.toLowerCase().includes(searchName.toLowerCase())) return false;
    if (filterType && task.type !== filterType) return false;
    if (filterUser && task.assignee !== filterUser) return false;
    const isRecurring = task.recurringDaily || task.recurringWeekly || task.recurringAnnually;
    if (viewMode==="today") return isToday(task.deadline) || (isRecurring && recurringOccursOn(task, toDateStr(new Date().toISOString())));
    if (viewMode==="date" && filterDate) return toDateStr(task.deadline)===filterDate || (isRecurring && recurringOccursOn(task, filterDate));
    if (viewMode==="range") {
      if (isRecurring) return true;
      if (!task.deadline) return false;
      const d = new Date(task.deadline);
      if (filterFrom && d < new Date(filterFrom)) return false;
      if (filterTo   && d > new Date(filterTo+"T23:59:59")) return false;
      return true;
    }
    return true;
  });

  const sorted = [...filteredTasks].sort((a,b) => {
    if (a.validated!==b.validated) return a.validated?1:-1;
    if (!a.deadline) return 1; if (!b.deadline) return -1;
    return new Date(a.deadline)-new Date(b.deadline);
  });

  const todayStr        = toDateStr(new Date().toISOString());
  const todayTasks      = tasks.filter(t => isToday(t.deadline) || ((t.recurringDaily||t.recurringWeekly||t.recurringAnnually) && recurringOccursOn(t, todayStr)));
  const doneCount       = filteredTasks.filter(t=>t.validated).length;
  const overdueCount    = filteredTasks.filter(t=>isOverdue(t.deadline,t.validated)).length;
  const unassignedCount = filteredTasks.filter(t=>!t.validated&&(!t.assignee||t.assignee===UNASSIGNED)).length;
  const criticalCount   = filteredTasks.filter(t=>isOverdue(t.deadline,t.validated)||(!t.assignee||t.assignee===UNASSIGNED)).length;

  const sortTasks = arr => [...arr].sort((a,b) => {
    if (a.validated!==b.validated) return a.validated?1:-1;
    if (!a.deadline) return 1; if (!b.deadline) return -1;
    return new Date(a.deadline)-new Date(b.deadline);
  });

  const baseFilter = t => {
    if (searchName && !t.name.toLowerCase().includes(searchName.toLowerCase())) return false;
    if (filterType && t.type !== filterType) return false;
    if (filterUser && t.assignee !== filterUser) return false;
    return true;
  };

  const sortedAllToday = sortTasks(tasks.filter(t => {
    if (!baseFilter(t)) return false;
    const rec = t.recurringDaily || t.recurringWeekly || t.recurringAnnually;
    return isToday(t.deadline) || (rec && recurringOccursOn(t, todayStr));
  }));

  const sortedAllUpcoming = sortTasks(tasks.filter(t => {
    if (!baseFilter(t)) return false;
    const rec = t.recurringDaily || t.recurringWeekly || t.recurringAnnually;
    const appearsToday = isToday(t.deadline) || (rec && recurringOccursOn(t, todayStr));
    if (appearsToday) return false;
    if (rec) return true;
    if (!t.deadline) return false;
    return new Date(t.deadline) > new Date();
  }));

  async function patchTask(id, patch) { await updateDoc(doc(db,"tasks",id), patch); }

  function openAdd() { setForm(emptyForm); setFormErrors({}); setModal({mode:"add"}); }
  function openEdit(task) {
    setForm({
      name:task.name, assignee:task.assignee||UNASSIGNED,
      deadlineDate:toLocalDatetime(task.deadline).date,
      deadlineTime:toLocalDatetime(task.deadline).time,
      type:task.type||"", comment:task.comment||"", shift:task.shift||"",
      fileName:task.fileName||null, fileData:task.fileData||null,
      recurringDaily:task.recurringDaily||false,
      recurringWeekly:task.recurringWeekly||false,
      weeklyDay:task.weeklyDay||"Monday", weeklyTime:task.weeklyTime||"09:00",
      recurringAnnually:task.recurringAnnually||false,
      recurringStart:task.recurringStart||"", recurringEnd:task.recurringEnd||"",
    });
    setFormErrors({});
    setModal({mode:"edit",task});
  }

  async function moveToNextDay(task) {
    const newDeadline = addDays(task.deadline || null, 1);
    await updateDoc(doc(db, "tasks", task.id), {
      deadline: newDeadline,
      validated: false,
      validatedAt: null,
      lastReset: null,
    });
  }

  function handleFile(e) {
    const file=e.target.files[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=ev=>setForm(f=>({...f,fileName:file.name,fileData:ev.target.result}));
    reader.readAsDataURL(file);
  }

  async function saveForm() {
    const errors = {};
    if (!form.name.trim()) errors.name = "Required";
    if (!form.type) errors.type = "Required";
    if (!form.deadlineDate) {
      errors.deadline = "Date required";
    } else {
      const year = parseInt(form.deadlineDate.slice(0, 4), 10);
      const month = parseInt(form.deadlineDate.slice(5, 7), 10);
      const day   = parseInt(form.deadlineDate.slice(8, 10), 10);
      const currentYear = new Date().getFullYear();
      if (year < currentYear)      errors.deadline = `Year ${year} is in the past`;
      else if (year > currentYear + 20) errors.deadline = `Year ${year} is too far in the future`;
      else if (month < 1 || month > 12) errors.deadline = `Month ${month} is invalid (1–12)`;
      else if (day   < 1 || day   > 31) errors.deadline = `Day ${day} is invalid (1–31)`;
      else if (!form.deadlineTime)      errors.deadline = "Time required";
    }
    if (Object.keys(errors).length > 0) { setFormErrors(errors); return; }
    setFormErrors({});

    const deadline = new Date(form.deadlineDate + "T" + form.deadlineTime).toISOString();
    const rec = { recurringDaily:form.recurringDaily, recurringWeekly:form.recurringWeekly, weeklyDay:form.weeklyDay, weeklyTime:form.weeklyTime, recurringAnnually:form.recurringAnnually, recurringStart:form.recurringStart||null, recurringEnd:form.recurringEnd||null };
    const payload = {
      name:form.name.trim(), assignee:form.assignee, deadline,
      type:form.type||"", comment:form.comment||"", shift:form.shift||"",
      fileName:form.fileName||null, fileData:form.fileData||null, ...rec
    };
    const mode = modal.mode;
    const taskId = modal.task?.id;
    setModal(null);
    if (mode==="add") {
      await addDoc(collection(db,"tasks"),{ ...payload, validated:false, validatedAt:null, createdAt:new Date().toISOString(), lastReset:null });
    } else {
      await updateDoc(doc(db,"tasks",taskId), payload);
    }
  }

  async function validate(task) {
    const newVal = !task.validated;
    await patchTask(task.id,{ validated:newVal, validatedAt:newVal?new Date().toISOString():null });
  }
  async function confirmDelete() {
    const task = deleteConfirmTask;
    setDeleteConfirmTask(null);
    setTasks(prev => prev.filter(t => t.id !== task.id));
    await addDoc(collection(db,"history"),{
      action:"deleted", at:new Date().toISOString(),
      name:task.name, assignee:task.assignee||"", type:task.type||"",
      deadline:task.deadline||null, shift:task.shift||"", comment:task.comment||"",
    });
    await deleteDoc(doc(db,"tasks",task.id));
  }

  const renderRows = (taskList) => {
    if (taskList.length === 0) return <tr><td colSpan={11} style={S.empty}>No tasks for this view.</td></tr>;
    return taskList.map((task, i) => {
      const overdue = isOverdue(task.deadline, task.validated);
      const nextReset = (task.recurringDaily||task.recurringWeekly||task.recurringAnnually) ? getNextReset(task) : null;
      return (
        <tr key={task.id} style={{...S.tr,...(task.validated?S.trDone:{}),...(overdue?S.trOverdue:{}),animation:overdue?"blink 1.2s ease-in-out infinite":"none"}}>
          <td style={S.td}><span style={S.idx}>{i+1}</span></td>
          <td style={{...S.td,...S.tdName}}>
            {task.validated&&<span style={S.check}>✓ </span>}
            <span style={task.validated?S.striked:{}}>{task.name}</span>
            {task.lastReset&&<div style={S.resetNote}>↺ auto-reopened</div>}
          </td>
          <td style={S.td}><InlineAssignee task={task} onUpdate={patchTask} users={users}/></td>
          <td style={S.td}><span style={{fontSize:11,color:"#a0a0c0"}}>{task.type||<span style={{opacity:0.2}}>—</span>}</span></td>
          <td style={S.td}>
            <span style={{...S.deadline,...(overdue?S.deadlineRed:{})}}>
              {formatDeadline(task.deadline)}
              {overdue&&<span style={S.badge}>OVERDUE</span>}
            </span>
          </td>
          <td style={S.td}><InlineShift task={task} onUpdate={patchTask}/></td>
          <td style={{...S.td,textAlign:"left"}}>
            <span style={{fontSize:11,color:"#a0a0c0",overflow:"hidden",textOverflow:"ellipsis",display:"block"}}>{task.comment||<span style={{opacity:0.2}}>—</span>}</span>
          </td>
          <td style={S.td}>
            {task.recurringDaily&&<DailyBadge nextReset={task.validated?nextReset:null}/>}
            {task.recurringWeekly&&<WeeklyBadge day={task.weeklyDay} time={task.weeklyTime} nextReset={task.validated?nextReset:null}/>}
            {task.recurringAnnually&&<AnnualBadge nextReset={task.validated?nextReset:null}/>}
            {!task.recurringDaily&&!task.recurringWeekly&&!task.recurringAnnually&&<span style={{opacity:0.2,fontSize:11}}>—</span>}
          </td>
          <td style={S.td}>
            {task.fileData?<button style={S.fileBtn} onClick={()=>setPreviewFile(task)}>📎 {task.fileName?.length>14?task.fileName.slice(0,12)+"…":task.fileName}</button>:<span style={{opacity:0.3}}>—</span>}
          </td>
          <td style={S.td}>
            <button style={{...S.validateBtn,...(task.validated?S.validateBtnDone:{})}} onClick={()=>validate(task)}>
              {task.validated?"✓ Done":"Mark done"}
            </button>
          </td>
          <td style={S.td}>
            <div style={S.actions}>
              <button style={S.iconBtn} title="Edit" onClick={()=>openEdit(task)}>✎</button>
              <button style={{...S.iconBtn,...S.iconBtnCopy}} title="Move to next day" onClick={()=>setMoveNextDayTask(task)}>→</button>
              <button style={{...S.iconBtn,...S.iconBtnRed}} title="Delete" onClick={()=>setDeleteConfirmTask(task)}>✕</button>
            </div>
          </td>
        </tr>
      );
    });
  };

  const tableColgroup = (
    <colgroup>
      <col style={{width:44}}/>
      <col style={{width:190}}/>
      <col style={{width:130}}/>
      <col style={{width:95}}/>
      <col style={{width:155}}/>
      <col style={{width:80}}/>
      <col style={{width:140}}/>
      <col style={{width:115}}/>
      <col style={{width:110}}/>
      <col style={{width:115}}/>
      <col style={{width:95}}/>
    </colgroup>
  );

  const tableHead = (
    <thead>
      <tr>
        {[["#","center"],["Task","left"],["Assigned to","center"],["Type","center"],["Deadline","center"],["Shift","center"],["Comment","left"],["Recurrence","center"],["Document","center"],["Status","center"],["Actions","center"]].map(([h,align])=>(
          <th key={h} style={{...S.th,textAlign:align}}>{h}</th>
        ))}
      </tr>
    </thead>
  );

  return (
    <div style={S.root}>
      <header style={S.header}>
        <div style={S.headerLeft}>
          <div style={S.logoMark}>✦</div>
          <div>
            <div style={S.title}>TaskFlow</div>
          </div>
        </div>
        <div style={S.stats}>
          <Stat label="Total"      value={filteredTasks.length} color="#c8b8ff"/>
          <Stat label="Done"       value={doneCount}            color="#6ee7b7"/>
          <Stat label="Overdue"    value={overdueCount}         color="#fca5a5"/>
          <Stat label="Unassigned" value={unassignedCount}      color="#74b0ff"/>
          <Stat label="Critical"   value={criticalCount}        color="#f97316"/>
        </div>
      </header>

      <main style={S.main}>
        <div style={S.filterBar}>
          <div style={S.filterTabs}>
            {[["all","All"],["today","Today"],["date","By Date"],["range","Range"],["history","📋 History"]].map(([v,l])=>(
              <button key={v} style={{...S.filterTab,...(viewMode===v?S.filterTabActive:{})}} onClick={()=>setViewMode(v)}>{l}</button>
            ))}
          </div>
          {viewMode==="date"&&<DatePickerInput compact value={filterDate} onChange={setFilterDate}/>}
          {viewMode==="range"&&(
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <DatePickerInput compact value={filterFrom} onChange={setFilterFrom}/>
              <span style={{color:"#6b6b9a",fontSize:12}}>→</span>
              <DatePickerInput compact value={filterTo} onChange={setFilterTo}/>
            </div>
          )}
          <input style={{...S.filterInput,minWidth:180}} placeholder="🔍 Search by name..." value={searchName} onChange={e=>setSearchName(e.target.value)}/>
          <select style={{...S.filterInput,minWidth:130}} value={filterType} onChange={e=>setFilterType(e.target.value)}>
            <option value="">All types</option>
            {TASK_TYPES.map(t=><option key={t}>{t}</option>)}
          </select>
          <select style={{...S.filterInput,minWidth:140}} value={filterUser} onChange={e=>setFilterUser(e.target.value)}>
            <option value="">👤 All users</option>
            {usersData.map(u=><option key={u.id} value={u.name}>{u.name}</option>)}
          </select>
          <button style={S.usersBtn} onClick={()=>setModal({mode:"manageUsers"})}>
            👥 Users ({usersData.length})
          </button>
          <button style={S.exportBtn} onClick={()=>exportToCSV(sorted)}>⬇ Export CSV</button>
        </div>

        {viewMode!=="history"&&<button style={{...S.addBtn,marginBottom:20}} onClick={openAdd}>+ Add task</button>}

        {viewMode==="history" ? (() => {
          const historyFiltered = history.filter(h => {
            if (h.action !== historyTab) return false;
            if (searchName && !h.name.toLowerCase().includes(searchName.toLowerCase())) return false;
            if (filterType && h.type !== filterType) return false;
            if (filterUser && h.assignee !== filterUser) return false;
            return true;
          });
          const doneCount = history.filter(h=>h.action==="done").length;
          const delCount  = history.filter(h=>h.action==="deleted").length;


          const details = (h) => [
            h.deadline && { label:"Deadline", value:formatDeadline(h.deadline) },
            h.shift    && { label:"Shift",    value:h.shift },
            h.comment  && { label:"Comment",  value:h.comment },
          ].filter(Boolean);

          return (
            <>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:16}}>
                {[["done",`✓ Done (${doneCount})`],["deleted",`✕ Deleted (${delCount})`]].map(([v,l])=>(
                  <button key={v} style={{...S.filterTab,...(historyTab===v?S.filterTabActive:{})}} onClick={()=>setHistoryTab(v)}>{l}</button>
                ))}
                {history.filter(h=>h.action===historyTab).length>0&&(
                  <button style={{...S.iconBtn,...S.iconBtnRed,marginLeft:"auto",padding:"6px 14px",width:"auto",fontSize:11}} onClick={()=>setHistoryDeleteConfirm({type:"clear",tab:historyTab})}>
                    🗑 Clear {historyTab === "done" ? "done" : "deleted"} history
                  </button>
                )}
              </div>
              {historyFiltered.length===0 ? (
                <div style={S.empty}>No {historyTab} tasks recorded yet.</div>
              ) : (
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {historyFiltered.map(h=>{
                    const det = details(h);
                    return (
                      <div key={h.id} style={{background:"#13131f",border:"1px solid #2a2a42",borderRadius:10,overflow:"hidden"}}>
                        <div style={{display:"flex",alignItems:"center",gap:12,padding:"14px 18px"}}>
                          <span style={{fontSize:16,color:h.action==="done"?"#6ee7b7":"#fca5a5",flexShrink:0,width:20,textAlign:"center"}}>{h.action==="done"?"✓":"✕"}</span>
                          <span style={{flex:2,fontSize:13,color:"#e8e4ff",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",cursor:det.length?"pointer":"default"}} onClick={()=>det.length&&setExpandedHistoryId(expandedHistoryId===h.id?null:h.id)}>{h.name}</span>
                          <span style={{flex:1,fontSize:12,color:"#a0a0c0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{h.assignee||"—"}</span>
                          <span style={{fontSize:11,color:"#c8b8ff",background:"#1e1e35",padding:"3px 10px",borderRadius:12,flexShrink:0}}>{h.type||"—"}</span>
                          <span style={{fontSize:11,color:"#6b6b9a",flexShrink:0,minWidth:130,textAlign:"right"}}>{h.at?new Date(h.at).toLocaleString("en-GB",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}):"—"}</span>
                          {det.length>0&&<span style={{color:"#6b6b9a",fontSize:10,cursor:"pointer",flexShrink:0}} onClick={()=>setExpandedHistoryId(expandedHistoryId===h.id?null:h.id)}>{expandedHistoryId===h.id?"▲":"▼"}</span>}
                          <button style={{...S.iconBtn,...S.iconBtnRed,flexShrink:0,width:26,height:26,fontSize:11}} title="Remove from history" onClick={()=>setHistoryDeleteConfirm({type:"entry",h})}>✕</button>
                        </div>
                        {expandedHistoryId===h.id&&det.length>0&&(
                          <div style={{borderTop:"1px solid #2a2a42",padding:"14px 20px",display:"flex",gap:32,flexWrap:"wrap"}}>
                            {det.map(({label,value})=>(
                              <div key={label}>
                                <div style={{fontSize:10,color:"#6b6b9a",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:4}}>{label}</div>
                                <div style={{fontSize:13,color:"#e8e4ff",fontWeight:500}}>{value}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          );
        })() : loading ? (
          <div style={S.empty}>Connecting to database...</div>
        ) : viewMode==="all" ? (
          <>
            <div style={S.sectionLabel}>Today</div>
            <div style={S.tableWrap}>
              <table style={S.table}>{tableColgroup}{tableHead}<tbody>{renderRows(sortedAllToday)}</tbody></table>
            </div>
            <div style={{...S.sectionLabel,marginTop:32}}>Upcoming</div>
            <div style={S.tableWrap}>
              <table style={S.table}>{tableColgroup}{tableHead}<tbody>{renderRows(sortedAllUpcoming)}</tbody></table>
            </div>
          </>
        ) : (
          <div style={S.tableWrap}>
            <table style={S.table}>{tableColgroup}{tableHead}<tbody>{renderRows(sorted)}</tbody></table>
          </div>
        )}
      </main>

      {/* ─── MANAGE USERS MODAL ─────────────────────────────────────────────── */}
      {modal?.mode==="manageUsers"&&(
        <div style={S.overlay} onClick={()=>setModal(null)}>
          <div style={{...S.modal,maxWidth:420}} onClick={e=>e.stopPropagation()}>
            <div style={S.modalTitle}>👥 Manage Users</div>

            {usersData.length===0&&(
              <div style={{color:"#6b6b9a",fontSize:13,textAlign:"center",padding:"16px 0"}}>No users yet. Add one below.</div>
            )}

            <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:320,overflowY:"auto"}}>
              {usersData.map(u=>(
                <div key={u.id} style={S.userRow}>
                  <span style={S.userName}>{u.name}</span>
                  <button
                    style={S.userDeleteBtn}
                    title="Remove user"
                    onClick={()=>deleteUser(u.id)}
                  >✕</button>
                </div>
              ))}
            </div>

            {userError&&<div style={{color:"#fca5a5",fontSize:11,padding:"6px 10px",background:"#ef444411",border:"1px solid #ef444433",borderRadius:6}}>{userError}</div>}

            <div style={{borderTop:"1px solid #2a2a42",paddingTop:14,display:"flex",gap:8}}>
              <input
                style={{...S.input,flex:1,...(userError?{borderColor:"#ef444488"}:{})}}
                placeholder="New user name..."
                value={newUserName}
                onChange={e=>{ setNewUserName(e.target.value); setUserError(""); }}
                onKeyDown={e=>e.key==="Enter"&&addUser()}
                autoFocus
              />
              <button
                style={{...S.saveBtn,padding:"10px 18px",whiteSpace:"nowrap"}}
                onClick={addUser}
                disabled={!newUserName.trim()}
              >+ Add</button>
            </div>

            <div style={S.modalBtns}>
              <button style={S.cancelBtn} onClick={()=>setModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── ADD / EDIT TASK MODAL ──────────────────────────────────────────── */}
      {modal&&modal.mode!=="manageUsers"&&(
        <div style={S.overlay} onClick={()=>setModal(null)}>
          <div style={S.modal} onClick={e=>e.stopPropagation()}>
            <div style={S.modalTitle}>{modal.mode==="add"?"New task":"Edit task"}</div>

            <label style={S.label}>Task name *</label>
            <input style={{...S.input,...(formErrors.name?{borderColor:"#ef444488"}:{})}} placeholder="e.g. Prepare the report..." value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} autoFocus/>
            {formErrors.name&&<div style={S.fieldError}>{formErrors.name}</div>}

            <div style={{display:"flex",gap:10}}>
              <div style={{flex:1}}>
                <label style={S.label}>Assigned to</label>
                <select style={S.input} value={form.assignee} onChange={e=>setForm(f=>({...f,assignee:e.target.value}))}>
                  {users.map(u=><option key={u}>{u}</option>)}
                </select>
              </div>
              <div style={{flex:1}}>
                <label style={S.label}>Type *</label>
                <select style={{...S.input,...(formErrors.type?{borderColor:"#ef444488"}:{})}} value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))}>
                  <option value="">— No type —</option>
                  {TASK_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
                </select>
                {formErrors.type&&<div style={S.fieldError}>{formErrors.type}</div>}
              </div>
            </div>

            <div>
              <label style={S.label}>Deadline *</label>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <div style={{flex:1}}>
                  <DatePickerInput
                    value={form.deadlineDate}
                    onChange={v=>setForm(f=>({...f,deadlineDate:v}))}
                    min={localToday()}
                    hasError={!!formErrors.deadline}
                  />
                </div>
                <button type="button" style={S.todayBtn} onClick={()=>setForm(f=>({...f,deadlineDate:localToday()}))}>Today</button>
              </div>
            </div>

            <div style={{display:"flex",gap:10}}>
              <div style={{flex:1}}>
                <label style={S.label}>Time *</label>
                <input ref={timeInputRef} type="time" style={{...S.input,...(formErrors.deadline?{borderColor:"#ef444488"}:{})}} value={form.deadlineTime} onChange={e=>setForm(f=>({...f,deadlineTime:e.target.value}))}/>
              </div>
              <div style={{flex:1}}>
                <label style={S.label}>Shift</label>
                <select style={S.input} value={form.shift} onChange={e=>setForm(f=>({...f,shift:e.target.value}))}>
                  {SHIFT_OPTIONS.map(s=><option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>
            {formErrors.deadline&&<div style={S.fieldError}>{formErrors.deadline}</div>}

            <label style={S.label}>Comment</label>
            <textarea style={{...S.input,resize:"vertical",minHeight:64}} placeholder="Any notes..." value={form.comment} onChange={e=>setForm(f=>({...f,comment:e.target.value}))}/>

            <div style={S.recurringRow}>
              <div style={{flex:1}}>
                <div style={S.recurringLabel}>↻ Recurring daily</div>
                <div style={S.recurringDesc}>Reopens automatically every day at midnight</div>
              </div>
              <Toggle checked={form.recurringDaily} onChange={()=>setForm(f=>({...f,recurringDaily:!f.recurringDaily,recurringWeekly:false,recurringAnnually:false,recurringStart:"",recurringEnd:""}))} color="#3b5bdb"/>
            </div>

            {form.recurringDaily&&(
              <div style={{display:"flex",gap:10,paddingLeft:8}}>
                <div style={{flex:1}}>
                  <label style={S.label}>Start date (optional)</label>
                  <DatePickerInput value={form.recurringStart} onChange={v=>setForm(f=>({...f,recurringStart:v}))}/>
                </div>
                <div style={{flex:1}}>
                  <label style={S.label}>End date (optional)</label>
                  <DatePickerInput value={form.recurringEnd} onChange={v=>setForm(f=>({...f,recurringEnd:v}))}/>
                </div>
              </div>
            )}

            <div style={S.recurringRow}>
              <div style={{flex:1}}>
                <div style={S.recurringLabel}>↻ Recurring weekly</div>
                <div style={S.recurringDesc}>Reopens automatically once a week</div>
              </div>
              <Toggle checked={form.recurringWeekly} onChange={()=>setForm(f=>({...f,recurringWeekly:!f.recurringWeekly,recurringDaily:false,recurringAnnually:false,recurringStart:"",recurringEnd:""}))} color="#7c3aed"/>
            </div>

            {form.recurringWeekly&&(
              <>
                <div style={{display:"flex",gap:10,paddingLeft:8}}>
                  <div style={{flex:1}}>
                    <label style={S.label}>Day</label>
                    <select style={S.input} value={form.weeklyDay} onChange={e=>setForm(f=>({...f,weeklyDay:e.target.value}))}>
                      {DAYS.map(d=><option key={d}>{d}</option>)}
                    </select>
                  </div>
                  <div style={{flex:1}}>
                    <label style={S.label}>Time</label>
                    <input type="time" style={S.input} value={form.weeklyTime} onChange={e=>setForm(f=>({...f,weeklyTime:e.target.value}))}/>
                  </div>
                </div>
                <div style={{display:"flex",gap:10,paddingLeft:8}}>
                  <div style={{flex:1}}>
                    <label style={S.label}>Start date (optional)</label>
                    <DatePickerInput value={form.recurringStart} onChange={v=>setForm(f=>({...f,recurringStart:v}))}/>
                  </div>
                  <div style={{flex:1}}>
                    <label style={S.label}>End date (optional)</label>
                    <DatePickerInput value={form.recurringEnd} onChange={v=>setForm(f=>({...f,recurringEnd:v}))}/>
                  </div>
                </div>
              </>
            )}

            <div style={S.recurringRow}>
              <div style={{flex:1}}>
                <div style={S.recurringLabel}>↻ Recurring annually</div>
                <div style={S.recurringDesc}>Reopens automatically every year on the same date</div>
              </div>
              <Toggle checked={form.recurringAnnually} onChange={()=>setForm(f=>({...f,recurringAnnually:!f.recurringAnnually,recurringDaily:false,recurringWeekly:false}))} color="#34d399"/>
            </div>

            <label style={S.label}>Document</label>
            <div style={S.fileRow}>
              <input ref={fileRef} type="file" style={{display:"none"}} onChange={handleFile}/>
              <button style={S.fileUploadBtn} onClick={()=>fileRef.current.click()}>
                📎 {form.fileName?form.fileName:"Choose a file"}
              </button>
              {form.fileName&&<button style={S.removeFile} onClick={()=>setForm(f=>({...f,fileName:null,fileData:null}))}>✕</button>}
            </div>

            <div style={S.modalBtns}>
              <button style={S.cancelBtn} onClick={()=>setModal(null)}>Cancel</button>
              <button style={S.saveBtn} onClick={saveForm}>{modal.mode==="add"?"Add task":"Save"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── FILE PREVIEW MODAL ─────────────────────────────────────────────── */}
      {previewFile&&(
        <div style={S.overlay} onClick={()=>setPreviewFile(null)}>
          <div style={{...S.modal,maxWidth:640}} onClick={e=>e.stopPropagation()}>
            <div style={S.modalTitle}>📎 {previewFile.fileName}</div>
            {previewFile.fileData?.startsWith("data:image")?<img src={previewFile.fileData} alt="preview" style={{width:"100%",borderRadius:8}}/>
              :previewFile.fileData?.startsWith("data:application/pdf")?<iframe src={previewFile.fileData} style={{width:"100%",height:400,border:"none",borderRadius:8}} title="pdf"/>
              :<p style={{color:"#c8b8ff"}}>Preview not available for this file type.</p>}
            <div style={S.modalBtns}>
              <a href={previewFile.fileData} download={previewFile.fileName} style={S.saveBtn}>⬇ Download</a>
              <button style={S.cancelBtn} onClick={()=>setPreviewFile(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── MOVE TO NEXT DAY CONFIRMATION ─────────────────────────────────── */}
      {moveNextDayTask&&(
        <div style={S.overlay} onClick={()=>setMoveNextDayTask(null)}>
          <div style={{...S.modal,maxWidth:380}} onClick={e=>e.stopPropagation()}>
            <div style={S.modalTitle}>Move to next day?</div>
            <p style={{color:"#a0a0c0",fontSize:13,lineHeight:1.6}}>
              Transfer <strong style={{color:"#e8e4ff"}}>"{moveNextDayTask.name}"</strong> to tomorrow?<br/>
              <span style={{fontSize:11,color:"#6b6b9a"}}>The task will be removed from today and rescheduled to the following day with the same parameters.</span>
            </p>
            <div style={S.modalBtns}>
              <button style={S.cancelBtn} onClick={()=>setMoveNextDayTask(null)}>Cancel</button>
              <button style={S.saveBtn} onClick={async()=>{ const t=moveNextDayTask; setMoveNextDayTask(null); await moveToNextDay(t); }}>Move to tomorrow</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── DELETE CONFIRMATION MODAL ──────────────────────────────────────── */}
      {deleteConfirmTask&&(
        <div style={S.overlay} onClick={()=>setDeleteConfirmTask(null)}>
          <div style={{...S.modal,maxWidth:380}} onClick={e=>e.stopPropagation()}>
            <div style={S.modalTitle}>Delete task?</div>
            <p style={{color:"#a0a0c0",fontSize:13,lineHeight:1.6}}>
              You are about to permanently delete:<br/>
              <span style={{color:"#e8e4ff",fontWeight:600}}>"{deleteConfirmTask.name}"</span>
            </p>
            <p style={{color:"#6b6b9a",fontSize:11}}>This action cannot be undone. The task will be saved in History.</p>
            <div style={S.modalBtns}>
              <button style={S.cancelBtn} onClick={()=>setDeleteConfirmTask(null)}>Cancel</button>
              <button style={{...S.saveBtn,background:"linear-gradient(135deg,#ef4444,#b91c1c)"}} onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── HISTORY DELETE CONFIRMATION ────────────────────────────────────── */}
      {historyDeleteConfirm&&(
        <div style={S.overlay} onClick={()=>setHistoryDeleteConfirm(null)}>
          <div style={{...S.modal,maxWidth:380}} onClick={e=>e.stopPropagation()}>
            <div style={S.modalTitle}>
              {historyDeleteConfirm.type==="clear" ? "Clear history?" : "Remove entry?"}
            </div>
            <p style={{color:"#a0a0c0",fontSize:13,lineHeight:1.6}}>
              {historyDeleteConfirm.type==="clear"
                ? <>Delete all <strong style={{color:"#e8e4ff"}}>{historyDeleteConfirm.tab}</strong> history entries? This cannot be undone.</>
                : <>Remove <strong style={{color:"#e8e4ff"}}>"{historyDeleteConfirm.h.name}"</strong> from history?</>
              }
            </p>
            <div style={S.modalBtns}>
              <button style={S.cancelBtn} onClick={()=>setHistoryDeleteConfirm(null)}>Cancel</button>
              <button style={{...S.saveBtn,background:"linear-gradient(135deg,#ef4444,#b91c1c)"}} onClick={async()=>{
                if (historyDeleteConfirm.type==="entry") {
                  const id = historyDeleteConfirm.h.id;
                  setHistoryDeleteConfirm(null);
                  setHistory(prev=>prev.filter(h=>h.id!==id));
                  await deleteDoc(doc(db,"history",id));
                } else {
                  const tab = historyDeleteConfirm.tab;
                  const toDelete = history.filter(h=>h.action===tab);
                  setHistoryDeleteConfirm(null);
                  setHistory(prev=>prev.filter(h=>h.action!==tab));
                  await Promise.all(toDelete.map(h=>deleteDoc(doc(db,"history",h.id))));
                }
              }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Syne:wght@700;800&display=swap');
        @keyframes blink{0%,100%{background:rgba(239,68,68,0.13)}50%{background:rgba(239,68,68,0.32)}}
        *{box-sizing:border-box;margin:0;padding:0}body{background:#0d0d14}
        ::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:#1a1a2e}::-webkit-scrollbar-thumb{background:#3d3d6b;border-radius:3px}
        select{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14'%3E%3Cpath fill='%23a0a0c0' d='M7 10L2 4h10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:32px !important}
        select option{background:#13131f;color:#e8e4ff}
        select option:checked{background:#7c3aed;color:#fff}
        select:focus{border-color:#7c3aed !important;box-shadow:0 0 0 2px #7c3aed22 !important;outline:none !important}
        input[type="date"],input[type="datetime-local"],input[type="time"]{color-scheme:dark;cursor:pointer}
        input[type="date"]::-webkit-calendar-picker-indicator,
        input[type="datetime-local"]::-webkit-calendar-picker-indicator,
        input[type="time"]::-webkit-calendar-picker-indicator{filter:invert(0.8);cursor:pointer;opacity:1}
      `}</style>
    </div>
  );
}

const S = {
  root:{ minHeight:"100vh", background:"#0d0d14", fontFamily:"'Inter',sans-serif", color:"#e8e4ff" },
  header:{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"28px 40px 20px", borderBottom:"1px solid #2a2a42", flexWrap:"wrap", gap:16 },
  headerLeft:{ display:"flex", alignItems:"center", gap:16 },
  logoMark:{ fontSize:32, color:"#c8b8ff", lineHeight:1, textShadow:"0 0 20px #c8b8ff88" },
  title:{ fontFamily:"'Syne',sans-serif", fontSize:26, fontWeight:800, color:"#fff", letterSpacing:"-0.5px" },
  subtitle:{ fontSize:11, color:"#6b6b9a", letterSpacing:"0.08em", marginTop:2 },
  stats:{ display:"flex", gap:24 },
  main:{ padding:"28px 40px 60px" },
  filterBar:{ display:"flex", alignItems:"center", gap:10, marginBottom:20, flexWrap:"wrap" },
  filterTabs:{ display:"flex", gap:4 },
  filterTab:{ background:"#1e1e35", border:"1px solid #2a2a42", color:"#6b6b9a", borderRadius:6, padding:"7px 14px", fontSize:11, cursor:"pointer", fontFamily:"inherit", letterSpacing:"0.06em" },
  filterTabActive:{ background:"#2a2a4a", border:"1px solid #7c3aed66", color:"#c8b8ff" },
  filterInput:{ background:"#0d0d14", border:"1px solid #2a2a42", borderRadius:8, padding:"7px 12px", color:"#e8e4ff", fontSize:12, fontFamily:"inherit", outline:"none", colorScheme:"dark" },
  usersBtn:{ background:"#1e1e35", border:"1px solid #c8b8ff44", color:"#c8b8ff", borderRadius:6, padding:"7px 14px", fontSize:11, cursor:"pointer", fontFamily:"inherit", letterSpacing:"0.04em" },
  exportBtn:{ marginLeft:"auto", background:"#1e1e35", border:"1px solid #3a3a5c", color:"#6ee7b7", borderRadius:6, padding:"7px 16px", fontSize:11, cursor:"pointer", fontFamily:"inherit" },
  tableWrap:{ overflowX:"auto", borderRadius:12, border:"1px solid #2a2a42" },
  table:{ width:"100%", borderCollapse:"collapse", minWidth:1269, tableLayout:"fixed" },
  th:{ padding:"14px 16px", textAlign:"left", fontSize:10, letterSpacing:"0.12em", color:"#6b6b9a", background:"#13131f", borderBottom:"1px solid #2a2a42", fontWeight:500, textTransform:"uppercase", whiteSpace:"nowrap" },
  tr:{ borderBottom:"1px solid #1e1e30", transition:"background 0.2s" },
  trDone:{ opacity:0.45 },
  trOverdue:{ borderLeft:"3px solid #ef4444" },
  td:{ padding:"14px 16px", fontSize:13, verticalAlign:"middle", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", textAlign:"center" },
  tdName:{ fontWeight:500, textAlign:"left" },
  idx:{ color:"#3d3d6b", fontSize:11 },
  check:{ color:"#6ee7b7" },
  striked:{ textDecoration:"line-through", opacity:0.6 },
  resetNote:{ fontSize:9, color:"#7c3aed", letterSpacing:"0.06em", marginTop:3 },
  assignee:{ background:"#1e1e35", padding:"3px 10px", borderRadius:20, fontSize:12, color:"#c8b8ff", cursor:"pointer" },
  deadline:{ fontSize:12, color:"#a0a0c0" },
  deadlineRed:{ color:"#fca5a5" },
  badge:{ display:"inline-block", marginLeft:8, background:"#ef444422", color:"#fca5a5", fontSize:9, letterSpacing:"0.1em", padding:"2px 7px", borderRadius:4, border:"1px solid #ef444444" },
  fileBtn:{ background:"none", border:"1px solid #3a3a5c", color:"#c8b8ff", borderRadius:6, padding:"4px 10px", fontSize:11, cursor:"pointer", fontFamily:"inherit" },
  validateBtn:{ background:"linear-gradient(135deg,#4f46e5,#7c3aed)", border:"none", color:"#fff", borderRadius:6, padding:"6px 16px", fontSize:12, cursor:"pointer", fontFamily:"inherit", transition:"all 0.2s", fontWeight:600 },
  validateBtnDone:{ background:"#162b22", border:"1px solid #6ee7b766", color:"#6ee7b7", fontWeight:500 },
  actions:{ display:"flex", gap:6 },
  iconBtn:{ background:"#1e1e35", border:"1px solid #3a3a5c", color:"#c8b8ff", borderRadius:6, width:30, height:30, cursor:"pointer", fontSize:14, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"inherit" },
  iconBtnRed:{ color:"#fca5a5", borderColor:"#ef444444" },
  iconBtnCopy:{ color:"#6ee7b7", borderColor:"#6ee7b744" },
  addBtn:{ marginTop:20, background:"linear-gradient(135deg,#7c3aed,#4f46e5)", color:"#fff", border:"none", borderRadius:8, padding:"12px 28px", fontSize:13, cursor:"pointer", fontFamily:"inherit", fontWeight:500, letterSpacing:"0.04em", boxShadow:"0 4px 20px #7c3aed44" },
  empty:{ textAlign:"center", padding:48, color:"#3d3d6b", fontSize:14 },
  overlay:{ position:"fixed", inset:0, background:"rgba(5,5,12,0.85)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:100, padding:20, backdropFilter:"blur(4px)" },
  modal:{ background:"#13131f", border:"1px solid #2a2a42", borderRadius:14, padding:32, width:"100%", maxWidth:500, display:"flex", flexDirection:"column", gap:12, maxHeight:"90vh", overflowY:"auto" },
  modalTitle:{ fontFamily:"'Syne',sans-serif", fontSize:20, fontWeight:800, color:"#fff", marginBottom:8 },
  label:{ fontSize:10, letterSpacing:"0.12em", color:"#6b6b9a", textTransform:"uppercase" },
  input:{ background:"#0d0d14", border:"1px solid #2a2a42", borderRadius:8, padding:"10px 14px", color:"#e8e4ff", fontSize:13, fontFamily:"inherit", outline:"none", width:"100%", colorScheme:"dark" },
  recurringRow:{ display:"flex", alignItems:"center", gap:12, background:"#0d0d14", border:"1px solid #2a2a42", borderRadius:8, padding:"12px 14px" },
  recurringLabel:{ fontSize:12, color:"#e8e4ff", fontWeight:500, marginBottom:2 },
  recurringDesc:{ fontSize:10, color:"#6b6b9a" },
  fileRow:{ display:"flex", gap:8, alignItems:"center" },
  fileUploadBtn:{ background:"#1e1e35", border:"1px solid #3a3a5c", color:"#c8b8ff", borderRadius:8, padding:"9px 16px", fontSize:12, cursor:"pointer", fontFamily:"inherit", flex:1, textAlign:"left", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  removeFile:{ background:"none", border:"1px solid #ef444444", color:"#fca5a5", borderRadius:6, width:32, height:32, cursor:"pointer", fontSize:14, fontFamily:"inherit", flexShrink:0 },
  modalBtns:{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:8 },
  cancelBtn:{ background:"none", border:"1px solid #2a2a42", color:"#6b6b9a", borderRadius:8, padding:"10px 20px", fontSize:13, cursor:"pointer", fontFamily:"inherit" },
  saveBtn:{ background:"linear-gradient(135deg,#7c3aed,#4f46e5)", border:"none", color:"#fff", borderRadius:8, padding:"10px 24px", fontSize:13, cursor:"pointer", fontFamily:"inherit", fontWeight:500, textDecoration:"none", display:"inline-flex", alignItems:"center" },
  sectionLabel:{ fontSize:14, letterSpacing:"0.08em", color:"#c8b8ff", textTransform:"uppercase", padding:"16px 0 10px", fontWeight:700 },
  todayBtn:{ background:"#1e1e35", border:"1px solid #c8b8ff44", color:"#c8b8ff", borderRadius:6, padding:"6px 12px", fontSize:11, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap", flexShrink:0 },
  fieldError:{ color:"#fca5a5", fontSize:11, marginTop:3 },
  // User management
  userRow:{ display:"flex", alignItems:"center", justifyContent:"space-between", background:"#0d0d14", border:"1px solid #2a2a42", borderRadius:8, padding:"10px 14px" },
  userName:{ fontSize:13, color:"#e8e4ff" },
  userDeleteBtn:{ background:"none", border:"1px solid #ef444444", color:"#fca5a5", borderRadius:6, width:28, height:28, cursor:"pointer", fontSize:12, fontFamily:"inherit", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" },
};
