
let token=localStorage.getItem("bkt_token"), me=null, selected=null, activeGroup=null, socket=null, registering=false;
const $=id=>document.getElementById(id);
function toggleAuth(){registering=!registering;$("authTitle").textContent=registering?"Регистрация":"Вход";$("authBtn").textContent=registering?"Создать аккаунт":"Войти";$("switch").textContent=registering?"Уже есть аккаунт? Войти":"Нет аккаунта? Регистрация";$("err").textContent=""}
async function api(url,opt={}){opt.headers={...(opt.headers||{}),Authorization:"Bearer "+token,"Content-Type":"application/json"};let r=await fetch(url,opt),d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||"Ошибка");return d}
async function authAction(){try{let d=await fetch("/api/"+(registering?"register":"login"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("login").value,password:$("pass").value})}).then(async r=>{let x=await r.json();if(!r.ok)throw Error(x.error);return x});token=d.token;localStorage.setItem("bkt_token",token);start()}catch(e){$("err").textContent=e.message}}
async function start(){try{me=await api("/api/me");$("auth").style.display="none";$("app").style.display="grid";$("me").textContent="@"+me.username;connect();loadUsers()}catch{localStorage.removeItem("bkt_token");token=null}}
function connect(){socket=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/?token="+encodeURIComponent(token));socket.onmessage=e=>{let d=JSON.parse(e.data);if(d.type==="message"&&selected&&(d.message.sender_id===selected.id||d.message.receiver_id===selected.id))renderMessage(d.message)}}
async function loadUsers(){
  const input = $("search");
  const q = (input?.value || "").trim().replace(/^@+/,"");
  const box = $("users");
  if (!box) return;

  if (!q) {
    box.innerHTML = "";
    return;
  }

  try {
    const list = await api("/api/users/search?q="+encodeURIComponent(q));
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = '<div style="padding:14px;color:#8d9893">Никого не найдено. Проверь @username.</div>';
      return;
    }

    for (const u of list) {
      const row = document.createElement("div");
      row.className = "user";
      row.onclick = () => openUser(u);
      const initial = escapeHtml((u.username || "?")[0].toUpperCase());
      const avatar = u.avatar
        ? `<img src="${escapeHtml(u.avatar)}" style="width:42px;height:42px;border-radius:50%;object-fit:cover">`
        : initial;
      row.innerHTML =
        `<div class="avatar">${avatar}</div>` +
        `<div><b>${verifiedName(u.username, !!u.verified)}</b><small>@${escapeHtml(u.username)}</small></div>`;
      box.appendChild(row);
    }
  } catch(e) {
    box.innerHTML = '<div style="padding:14px;color:#ff8d8d">'+escapeHtml(e.message||"Ошибка поиска")+'</div>';
  }
}
async function loadGroups(){
 try{const gs=await api('/api/groups');$("groups").innerHTML=gs.map(g=>`<div class="group-item" onclick='openGroup(${JSON.stringify(g)})'>👥 ${escapeHtml(g.name)}<small style="display:block;color:#8d9893">${g.members.length} участников</small></div>`).join('')}catch(e){console.error(e)}
}
async function createGroup(){
 const name=prompt('Название группы:'); if(!name||!name.trim())return;
 const raw=prompt('Введите @username участников через запятую:')||''; const ids=[];
 for(const n0 of raw.split(',')){const n=n0.trim().replace(/^@+/,'');if(!n)continue;try{const a=await api('/api/users?q='+encodeURIComponent(n));const u=a.find(x=>x.username.toLowerCase()===n.toLowerCase())||a[0];if(u)ids.push(u.id)}catch{}}
 try{const g=await api('/api/groups',{method:'POST',body:JSON.stringify({name:name.trim(),memberIds:ids})});openGroup(g);loadGroups()}catch(e){alert(e.message)}
}
async function openGroup(g){activeGroup=g;selected=null;$("app").classList.add('mobile-chat');$("headName").textContent=g.name;$("headAvatar").textContent='👥';$("headStatus").textContent=` ${g.members.length} участников`;const ms=await api('/api/groups/'+g.id+'/messages');$("messages").innerHTML='';ms.forEach(renderGroupMessage)}
function renderGroupMessage(m){if($("gm"+m.id))return;const d=document.createElement('div');d.id='gm'+m.id;d.className='bubble '+(m.sender_id===me.id?'me':'');const w=document.createElement('div');w.style.fontSize='12px';w.style.opacity='.7';w.textContent=m.sender_name;d.appendChild(w);const t=document.createElement('div');t.textContent=m.text;d.appendChild(t);$("messages").appendChild(d);$("messages").scrollTop=$("messages").scrollHeight}
async function openUser(u){activeGroup=null;selected=u;$("headName").textContent=u.username;$("headAvatar").textContent=u.username[0].toUpperCase();$("headStatus").textContent=" ● онлайн";let ms=await api("/api/messages/"+u.id);$("messages").innerHTML="";ms.forEach(renderMessage);$("messages").scrollTop=$("messages").scrollHeight;loadUsers()}
function renderMessage(m){
  if(document.getElementById("m"+m.id))return;
  const d=document.createElement("div");
  d.id="m"+m.id;
  d.className="bubble "+(m.sender_id===me.id?"me":"");

  if(m.text.startsWith("[VOICE]")){
    const audio=document.createElement("audio");
    audio.controls=true;
    audio.preload="metadata";
    audio.src=m.text.substring(7);
    audio.style.maxWidth="230px";
    d.appendChild(audio);
  } else if(m.text.startsWith("[VIDEO_NOTE]")){
    const video=document.createElement("video");
    video.controls=true;
    video.playsInline=true;
    video.preload="metadata";
    video.src=m.text.substring(12);
    video.style.width="180px";
    video.style.height="180px";
    video.style.objectFit="cover";
    video.style.borderRadius="50%";
    video.style.display="block";
    d.appendChild(video);
  } else {
    d.textContent=m.text;
  }

  const t=document.createElement("time");
  t.textContent=new Date(m.created_at.replace(" ","T")+"Z").toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});
  d.appendChild(t);
  document.getElementById("messages").appendChild(d);
  document.getElementById("messages").scrollTop=document.getElementById("messages").scrollHeight;
}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function mobileBack(){$("app").classList.remove("mobile-chat");loadUsers();}
start();
setTimeout(loadGroups,700);
setTimeout(loadGroups, 500);

let voiceRecorder=null, voiceChunks=[], voiceStream=null, voiceTimer=null, voiceSeconds=0;
let videoRecorder=null, videoChunks=[], videoStream=null, videoTimer=null, videoSeconds=0;

document.getElementById("voiceButton").addEventListener("click", startVoiceRecording);
document.getElementById("videoNoteButton").addEventListener("click", startVideoRecording);

function pickMime(types){
  return types.find(x=>MediaRecorder.isTypeSupported(x)) || "";
}

async function startVoiceRecording(){
  if(!selected)return alert("Сначала выберите чат");
  try{
    voiceStream=await navigator.mediaDevices.getUserMedia({audio:true});
    const mime=pickMime(["audio/webm;codecs=opus","audio/mp4"]);
    voiceRecorder=new MediaRecorder(voiceStream,mime?{mimeType:mime}:undefined);
    voiceChunks=[];
    voiceRecorder.ondataavailable=e=>{if(e.data.size)voiceChunks.push(e.data)};
    voiceRecorder.start();
    voiceSeconds=0;
    $("recording").style.display="flex";
    $("voiceButton").classList.add("recording-active");
    voiceTimer=setInterval(()=>{
      voiceSeconds++;
      $("recordTime").textContent=`${Math.floor(voiceSeconds/60)}:${String(voiceSeconds%60).padStart(2,"0")}`;
      if(voiceSeconds>=120)finishRecording();
    },1000);
  }catch(e){console.error(e);alert("Разреши доступ к микрофону.")}
}

async function finishRecording(){
  if(!voiceRecorder)return;
  clearInterval(voiceTimer);
  const rec=voiceRecorder;
  const stream=voiceStream;
  rec.onstop=async()=>{
    stream.getTracks().forEach(t=>t.stop());
    const blob=new Blob(voiceChunks,{type:rec.mimeType||"audio/webm"});
    await uploadMediaFile(blob,"audio");
    voiceRecorder=null;voiceStream=null;voiceChunks=[];
  };
  rec.stop();
  $("recording").style.display="none";
  $("voiceButton").classList.remove("recording-active");
}

function cancelRecording(){
  if(voiceRecorder)voiceRecorder.stop();
  if(voiceStream)voiceStream.getTracks().forEach(t=>t.stop());
  clearInterval(voiceTimer);
  voiceRecorder=null;voiceStream=null;voiceChunks=[];
  $("recording").style.display="none";
  $("voiceButton").classList.remove("recording-active");
}

async function startVideoRecording(){
  if(!selected)return alert("Сначала выберите чат");
  try{
    videoStream=await navigator.mediaDevices.getUserMedia({audio:true,video:true});
    const mime=pickMime(["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm","video/mp4"]);
    videoRecorder=new MediaRecorder(videoStream,mime?{mimeType:mime}:undefined);
    videoChunks=[];
    $("videoPreview").srcObject=videoStream;
    $("videoPreview").play().catch(()=>{});
    videoRecorder.ondataavailable=e=>{if(e.data.size)videoChunks.push(e.data)};
    videoRecorder.start();
    videoSeconds=0;
    $("videoRecording").style.display="flex";
    videoTimer=setInterval(()=>{
      videoSeconds++;
      $("videoTime").textContent=`${Math.floor(videoSeconds/60)}:${String(videoSeconds%60).padStart(2,"0")}`;
      if(videoSeconds>=60)finishVideoRecording();
    },1000);
  }catch(e){console.error(e);alert("Разреши доступ к камере и микрофону.")}
}

async function finishVideoRecording(){
  if(!videoRecorder)return;
  clearInterval(videoTimer);
  const rec=videoRecorder, stream=videoStream;
  rec.onstop=async()=>{
    stream.getTracks().forEach(t=>t.stop());
    const blob=new Blob(videoChunks,{type:rec.mimeType||"video/webm"});
    await uploadMediaFile(blob,"video");
    videoRecorder=null;videoStream=null;videoChunks=[];
    $("videoPreview").srcObject=null;
  };
  rec.stop();
  $("videoRecording").style.display="none";
}

function cancelVideoRecording(){
  if(videoRecorder)videoRecorder.stop();
  if(videoStream)videoStream.getTracks().forEach(t=>t.stop());
  clearInterval(videoTimer);
  videoRecorder=null;videoStream=null;videoChunks=[];
  $("videoPreview").srcObject=null;
  $("videoRecording").style.display="none";
}

async function uploadMediaFile(blob,kind){
  if(!selected)return;
  const form=new FormData();
  const ext=blob.type.includes("mp4")?"mp4":"webm";
  form.append("media",blob,`${kind}-${Date.now()}.${ext}`);
  form.append("receiverId",selected.id);
  form.append("kind",kind);
  try{
    const r=await fetch("/api/media",{method:"POST",headers:{Authorization:"Bearer "+token},body:form});
    const msg=await r.json();
    if(!r.ok)throw Error(msg.error||"Ошибка отправки");
    // The WebSocket may deliver the same message; renderMessage ignores duplicates.
    renderMessage(msg);
  }catch(e){console.error(e);alert("Не удалось отправить: "+e.message)}
}


async function openSettings(){
  try{
    const p = await api("/api/profile");
    $("profileUsername").value = p.username || "";
    $("profileBio").value = p.bio || "";
    $("profileAvatar").value = p.avatar || "";
    $("settingsError").style.color = "";
    $("settingsError").textContent = "";
    $("settingsModal").style.display = "grid";
  }catch(e){
    $("settingsError").textContent = e.message || "Не удалось загрузить профиль";
    $("settingsModal").style.display = "grid";
  }
}
function closeSettings(){ $("settingsModal").style.display="none"; }
async function saveSettings(){
 try{
  const p=await api("/api/profile",{method:"PATCH",body:JSON.stringify({
   username:$("profileUsername").value.trim(),
   bio:$("profileBio").value,
   avatar:$("profileAvatar").value.trim()
  })});
  me={...me,...p};
  $("me").textContent="@"+p.username;
  $("settingsError").style.color="#22ff72";
  $("settingsError").textContent="Профиль сохранён";
  setTimeout(closeSettings,700);
  loadUsers();
 }catch(e){
  $("settingsError").style.color="#ff8d8d";
  $("settingsError").textContent=e.message||"Не удалось сохранить профиль";
 }
}
function logout(){
  try { if (socket) socket.close(); } catch {}
  localStorage.removeItem("bkt_token");
  localStorage.removeItem("token");
  sessionStorage.removeItem("bkt_token");
  token = null; me = null; selected = null; activeGroup = null;
  if ($("settingsModal")) $("settingsModal").style.display = "none";
  if ($("app")) $("app").style.display = "none";
  if ($("auth")) $("auth").style.display = "grid";
}


let searchTimer;
const searchInput = document.getElementById("search");
if (searchInput) {
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadUsers, 180);
  });
  searchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); clearTimeout(searchTimer); loadUsers(); }
  });
}

