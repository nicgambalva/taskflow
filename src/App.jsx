import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc
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
const USERS = ["— Unassigned —","Matthieu","Tétiana","Melvyn","Nicolas","Ksenia","Sudhir","Lilia","Shamir"];
const DAYS  = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const DAY_INDEX = { Monday:1,Tuesday:2,Wednesday:3,Thursday:4,Friday:5,Saturday:6,Sunday:0 };

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
  const d = new Date(dateStr + "T12:00:00");
  if (task.recurringDaily) return true;
  if (task.recurringWeekly) return d.getDay() === (DAY_INDEX[task.weeklyDay] ?? 1);
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
  return null;
}
function formatNextReset(iso) {
  if (!iso) return "";
  const diffMs = new Date(iso)-new Date();
  const diffH = Math.floor(diffMs/3600000);
  const diffD = Math.floor(diffMs/86400000);
  return diffH<24?`in ${diffH}h`:`in ${diffD}d`;
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

// ─── INLINE SELECT (reusable — fixes the blur-before-change race) ─────────────
// Uses onMouseDown on options to register the pick before onBlur fires.
function InlineSelect({ value, options, onPick, onClose, renderTrigger }) {
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
      {/* Spacer so row doesn't collapse */}
      <span style={{visibility:"hidden"}}>{renderTrigger(value)}</span>
    </div>
  );
}

// ─── INLINE ASSIGNEE ──────────────────────────────────────────────────────────
function InlineAssignee({ task, onUpdate }) {
  const userOptions = USERS.map(u => ({ value: u, label: u }));
  return (
    <InlineSelect
      value={task.assignee || "— Unassigned —"}
      options={userOptions}
      onPick={val => onUpdate(task.id, { assignee: val })}
      renderTrigger={val => (
        <span style={{...S.assignee}}>
          {val === "— Unassigned —" ? <em style={{opacity:0.5}}>—</em> : val}
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
  name:"", assignee:"— Unassigned —", deadline:"", type:"", comment:"",
  shift:"", rescheduleDate:"", fileName:null, fileData:null,
  recurringDaily:false, recurringWeekly:false, weeklyDay:"Monday", weeklyTime:"09:00",
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tasks, setTasks]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]     = useState(null);
  const [form, setForm]       = useState(emptyForm);
  const [previewFile, setPreviewFile] = useState(null);

  const [viewMode, setViewMode]     = useState("today");
  const [filterDate, setFilterDate] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo]     = useState("");
  const [filterType, setFilterType] = useState("");
  const [searchName, setSearchName] = useState("");

  const fileRef = useRef();

  useEffect(() => {
    const unsub = onSnapshot(collection(db,"tasks"), snapshot => {
      setTasks(snapshot.docs.map(d => ({ id:d.id, ...d.data() })));
      setLoading(false);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    async function checkResets() {
      const now = new Date();
      for (const task of tasks) {
        if (!task.validated) continue;
        if (!task.recurringDaily && !task.recurringWeekly) continue;
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

  const taskTypes = [...new Set(tasks.map(t=>t.type).filter(Boolean))];

  const filteredTasks = tasks.filter(task => {
    if (searchName && !task.name.toLowerCase().includes(searchName.toLowerCase())) return false;
    if (filterType && task.type !== filterType) return false;
    const isRecurring = task.recurringDaily || task.recurringWeekly;
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

  const todayTasks      = tasks.filter(t => isToday(t.deadline) || ((t.recurringDaily||t.recurringWeekly) && recurringOccursOn(t, toDateStr(new Date().toISOString()))));
  const doneCount       = filteredTasks.filter(t=>t.validated).length;
  const overdueCount    = filteredTasks.filter(t=>isOverdue(t.deadline,t.validated)).length;
  const unassignedCount = todayTasks.filter(t=>!t.validated&&(!t.assignee||t.assignee==="— Unassigned —")).length;
  const criticalCount   = filteredTasks.filter(t=>isOverdue(t.deadline,t.validated)||(!t.assignee||t.assignee==="— Unassigned —")).length;

  async function patchTask(id, patch) { await updateDoc(doc(db,"tasks",id), patch); }

  function openAdd() { setForm(emptyForm); setModal({mode:"add"}); }
  function openEdit(task) {
    setForm({
      name:task.name, assignee:task.assignee||"— Unassigned —",
      deadline:task.deadline?task.deadline.slice(0,16):"",
      type:task.type||"", comment:task.comment||"", shift:task.shift||"",
      rescheduleDate:task.rescheduleDate||"",
      fileName:task.fileName||null, fileData:task.fileData||null,
      recurringDaily:task.recurringDaily||false,
      recurringWeekly:task.recurringWeekly||false,
      weeklyDay:task.weeklyDay||"Monday", weeklyTime:task.weeklyTime||"09:00",
    });
    setModal({mode:"edit",task});
  }

  // Fixed: always creates a new deadline even if original has none
  async function copyToNextDay(task) {
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
    if (!form.name.trim()) return;
    const deadline = form.deadline ? new Date(form.deadline).toISOString() : null;
    const rec = { recurringDaily:form.recurringDaily, recurringWeekly:form.recurringWeekly, weeklyDay:form.weeklyDay, weeklyTime:form.weeklyTime };
    const payload = {
      name:form.name.trim(), assignee:form.assignee, deadline,
      type:form.type||"", comment:form.comment||"", shift:form.shift||"",
      rescheduleDate:form.rescheduleDate||null,
      fileName:form.fileName||null, fileData:form.fileData||null, ...rec
    };
    if (modal.mode==="add") {
      await addDoc(collection(db,"tasks"),{ ...payload, validated:false, validatedAt:null, createdAt:new Date().toISOString(), lastReset:null });
    } else {
      await updateDoc(doc(db,"tasks",modal.task.id), payload);
    }
    setModal(null);
  }

  async function validate(task) {
    const newVal = !task.validated;
    await patchTask(task.id,{ validated:newVal, validatedAt:newVal?new Date().toISOString():null });
  }
  async function deleteTask(id) { await deleteDoc(doc(db,"tasks",id)); }

  return (
    <div style={S.root}>
      <header style={S.header}>
        <div style={S.headerLeft}>
          <div style={S.logoMark}>✦</div>
          <div>
            <div style={S.title}>TaskFlow</div>
            <div style={S.subtitle}>Shared collaborative workspace</div>
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
            {[["today","Today"],["date","By Date"],["range","Range"]].map(([v,l])=>(
              <button key={v} style={{...S.filterTab,...(viewMode===v?S.filterTabActive:{})}} onClick={()=>setViewMode(v)}>{l}</button>
            ))}
          </div>
          {viewMode==="date"&&<input type="date" style={S.filterInput} value={filterDate} onChange={e=>setFilterDate(e.target.value)}/>}
          {viewMode==="range"&&(
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <input type="date" style={S.filterInput} value={filterFrom} onChange={e=>setFilterFrom(e.target.value)}/>
              <span style={{color:"#6b6b9a",fontSize:12}}>→</span>
              <input type="date" style={S.filterInput} value={filterTo} onChange={e=>setFilterTo(e.target.value)}/>
            </div>
          )}
          <input style={{...S.filterInput,minWidth:180}} placeholder="🔍 Search by name..." value={searchName} onChange={e=>setSearchName(e.target.value)}/>
          <select style={{...S.filterInput,minWidth:130}} value={filterType} onChange={e=>setFilterType(e.target.value)}>
            <option value="">All types</option>
            {taskTypes.map(t=><option key={t}>{t}</option>)}
          </select>
          <button style={S.exportBtn} onClick={()=>exportToCSV(sorted)}>⬇ Export CSV</button>
        </div>

        {loading ? (
          <div style={S.empty}>Connecting to database...</div>
        ) : (
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  {["#","Task","Assigned to","Type","Deadline","Shift","Comment","↻ Daily","↻ Weekly","Document","Status","Actions"].map(h=>(
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.length===0&&<tr><td colSpan={12} style={S.empty}>No tasks for this view.</td></tr>}
                {sorted.map((task,i)=>{
                  const overdue=isOverdue(task.deadline,task.validated);
                  const nextReset=(task.recurringDaily||task.recurringWeekly)?getNextReset(task):null;
                  return (
                    <tr key={task.id} style={{...S.tr,...(task.validated?S.trDone:{}),...(overdue?S.trOverdue:{}),animation:overdue?"blink 1.2s ease-in-out infinite":"none"}}>
                      <td style={S.td}><span style={S.idx}>{i+1}</span></td>
                      <td style={{...S.td,...S.tdName}}>
                        {task.validated&&<span style={S.check}>✓ </span>}
                        <span style={task.validated?S.striked:{}}>{task.name}</span>
                        {task.lastReset&&<div style={S.resetNote}>↺ auto-reopened</div>}
                      </td>
                      <td style={S.td}><InlineAssignee task={task} onUpdate={patchTask}/></td>
                      <td style={S.td}><span style={{fontSize:11,color:"#a0a0c0"}}>{task.type||<span style={{opacity:0.2}}>—</span>}</span></td>
                      <td style={S.td}>
                        <span style={{...S.deadline,...(overdue?S.deadlineRed:{})}}>
                          {formatDeadline(task.deadline)}
                          {overdue&&<span style={S.badge}>OVERDUE</span>}
                        </span>
                      </td>
                      <td style={{...S.td,textAlign:"center"}}>
                        <InlineShift task={task} onUpdate={patchTask}/>
                      </td>
                      <td style={{...S.td,maxWidth:140}}>
                        <span style={{fontSize:11,color:"#a0a0c0",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",display:"block",maxWidth:130}}>{task.comment||<span style={{opacity:0.2}}>—</span>}</span>
                      </td>
                      <td style={{...S.td,textAlign:"center"}}>
                        {task.recurringDaily?<DailyBadge nextReset={task.validated?nextReset:null}/>:<span style={{opacity:0.2,fontSize:11}}>—</span>}
                      </td>
                      <td style={{...S.td,textAlign:"center"}}>
                        {task.recurringWeekly?<WeeklyBadge day={task.weeklyDay} time={task.weeklyTime} nextReset={task.validated?nextReset:null}/>:<span style={{opacity:0.2,fontSize:11}}>—</span>}
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
                          <button style={{...S.iconBtn,...S.iconBtnCopy}} title="Copy to next day" onClick={async ()=>{ try{ await copyToNextDay(task); alert("Rescheduled"); } catch(e){ alert("Error: "+e.message); }}}>+1</button>
                          <button style={{...S.iconBtn,...S.iconBtnRed}} title="Delete" onClick={()=>deleteTask(task.id)}>✕</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <button style={S.addBtn} onClick={openAdd}>+ Add task</button>
      </main>

      {modal&&(
        <div style={S.overlay} onClick={()=>setModal(null)}>
          <div style={S.modal} onClick={e=>e.stopPropagation()}>
            <div style={S.modalTitle}>{modal.mode==="add"?"New task":"Edit task"}</div>

            <label style={S.label}>Task name *</label>
            <input style={S.input} placeholder="e.g. Prepare the report..." value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} autoFocus/>

            <div style={{display:"flex",gap:10}}>
              <div style={{flex:1}}>
                <label style={S.label}>Assigned to</label>
                <select style={S.input} value={form.assignee} onChange={e=>setForm(f=>({...f,assignee:e.target.value}))}>
                  {USERS.map(u=><option key={u}>{u}</option>)}
                </select>
              </div>
              <div style={{flex:1}}>
                <label style={S.label}>Type</label>
                <input style={S.input} placeholder="e.g. Review, Call..." value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))}/>
              </div>
            </div>

            <div style={{display:"flex",gap:10}}>
              <div style={{flex:2}}>
                <label style={S.label}>Deadline</label>
                <input type="datetime-local" style={S.input} value={form.deadline} onChange={e=>setForm(f=>({...f,deadline:e.target.value}))}/>
              </div>
              <div style={{flex:1}}>
                <label style={S.label}>Shift</label>
                <select style={S.input} value={form.shift} onChange={e=>setForm(f=>({...f,shift:e.target.value}))}>
                  {SHIFT_OPTIONS.map(s=><option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>

            <label style={S.label}>Reschedule to date (optional)</label>
            <input type="date" style={S.input} value={form.rescheduleDate} onChange={e=>setForm(f=>({...f,rescheduleDate:e.target.value}))}/>

            <label style={S.label}>Comment</label>
            <textarea style={{...S.input,resize:"vertical",minHeight:64}} placeholder="Any notes..." value={form.comment} onChange={e=>setForm(f=>({...f,comment:e.target.value}))}/>

            <div style={S.recurringRow}>
              <div style={{flex:1}}>
                <div style={S.recurringLabel}>↻ Recurring daily</div>
                <div style={S.recurringDesc}>Reopens automatically every day at midnight</div>
              </div>
              <Toggle checked={form.recurringDaily} onChange={()=>setForm(f=>({...f,recurringDaily:!f.recurringDaily,recurringWeekly:!f.recurringDaily?false:f.recurringWeekly}))} color="#3b5bdb"/>
            </div>

            <div style={S.recurringRow}>
              <div style={{flex:1}}>
                <div style={S.recurringLabel}>↻ Recurring weekly</div>
                <div style={S.recurringDesc}>Reopens automatically once a week</div>
              </div>
              <Toggle checked={form.recurringWeekly} onChange={()=>setForm(f=>({...f,recurringWeekly:!f.recurringWeekly,recurringDaily:!f.recurringWeekly?false:f.recurringDaily}))} color="#7c3aed"/>
            </div>

            {form.recurringWeekly&&(
              <div style={{display:"flex",gap:10}}>
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
            )}

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

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700;800&display=swap');
        @keyframes blink{0%,100%{background:rgba(239,68,68,0.13)}50%{background:rgba(239,68,68,0.32)}}
        *{box-sizing:border-box;margin:0;padding:0}body{background:#0d0d14}
        ::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:#1a1a2e}::-webkit-scrollbar-thumb{background:#3d3d6b;border-radius:3px}
        select option{background:#13131f;color:#e8e4ff}
        input[type="date"],input[type="datetime-local"],input[type="time"]{color-scheme:dark;cursor:pointer}
        input[type="date"]::-webkit-calendar-picker-indicator,
        input[type="datetime-local"]::-webkit-calendar-picker-indicator,
        input[type="time"]::-webkit-calendar-picker-indicator{filter:invert(0.8);cursor:pointer;opacity:1}
      `}</style>
    </div>
  );
}

const S = {
  root:{ minHeight:"100vh", background:"#0d0d14", fontFamily:"'DM Mono',monospace", color:"#e8e4ff" },
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
  exportBtn:{ marginLeft:"auto", background:"#1e1e35", border:"1px solid #3a3a5c", color:"#6ee7b7", borderRadius:6, padding:"7px 16px", fontSize:11, cursor:"pointer", fontFamily:"inherit" },
  tableWrap:{ overflowX:"auto", borderRadius:12, border:"1px solid #2a2a42" },
  table:{ width:"100%", borderCollapse:"collapse", minWidth:1100 },
  th:{ padding:"14px 16px", textAlign:"left", fontSize:10, letterSpacing:"0.12em", color:"#6b6b9a", background:"#13131f", borderBottom:"1px solid #2a2a42", fontWeight:500, textTransform:"uppercase", whiteSpace:"nowrap" },
  tr:{ borderBottom:"1px solid #1e1e30", transition:"background 0.2s" },
  trDone:{ opacity:0.45 },
  trOverdue:{ borderLeft:"3px solid #ef4444" },
  td:{ padding:"14px 16px", fontSize:13, verticalAlign:"middle" },
  tdName:{ fontWeight:500, maxWidth:180 },
  idx:{ color:"#3d3d6b", fontSize:11 },
  check:{ color:"#6ee7b7" },
  striked:{ textDecoration:"line-through", opacity:0.6 },
  resetNote:{ fontSize:9, color:"#7c3aed", letterSpacing:"0.06em", marginTop:3 },
  assignee:{ background:"#1e1e35", padding:"3px 10px", borderRadius:20, fontSize:12, color:"#c8b8ff", cursor:"pointer" },
  deadline:{ fontSize:12, color:"#a0a0c0" },
  deadlineRed:{ color:"#fca5a5" },
  badge:{ display:"inline-block", marginLeft:8, background:"#ef444422", color:"#fca5a5", fontSize:9, letterSpacing:"0.1em", padding:"2px 7px", borderRadius:4, border:"1px solid #ef444444" },
  fileBtn:{ background:"none", border:"1px solid #3a3a5c", color:"#c8b8ff", borderRadius:6, padding:"4px 10px", fontSize:11, cursor:"pointer", fontFamily:"inherit" },
  validateBtn:{ background:"#1e1e35", border:"1px solid #3a3a5c", color:"#a0a0c0", borderRadius:6, padding:"5px 14px", fontSize:12, cursor:"pointer", fontFamily:"inherit", transition:"all 0.2s" },
  validateBtnDone:{ background:"#162b22", border:"1px solid #6ee7b766", color:"#6ee7b7" },
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
};
