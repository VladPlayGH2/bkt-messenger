
let token=sessionStorage.getItem("bkt_token")||null, me=null, selected=null, activeGroup=null, socket=null, registering=false, selectedRegistrationAvatar="";
// Never reuse a persistent login token left by another person/browser session.
function $(id){return document.getElementById(id)}
function toggleProtectedCode(){const username=$("login").value.trim().replace(/^@/,"").toLowerCase(); const protectedUser=["brozi","vlad","vladmobile"].includes(username); $("accessCode").style.display=protectedUser?"block":"none"; $("accessCode").placeholder=protectedUser?"Секретный код":"Секретный код";}
const REGISTRATION_AVATARS = Array.from({length:28},(_,i)=>`/stickers/${i+1}.webp`);
function renderRegistrationAvatarPicker(){
  const picker=$("registerAvatarPicker"), grid=$("registerAvatarGrid"), selected=$("registerAvatarSelected");
  picker.classList.toggle("show",registering);
  if(selectedRegistrationAvatar) selected.innerHTML=`<img src="${selectedRegistrationAvatar}" alt=""><span>Выбранная аватарка</span>`;
  else selected.innerHTML='<span>Аватарка не выбрана</span>';
  grid.innerHTML="";
  REGISTRATION_AVATARS.forEach(src=>{const b=document.createElement("button");b.type="button";b.className="auth-avatar-item"+(selectedRegistrationAvatar===src?" selected":"");b.innerHTML=`<img src="${src}" alt="">`;b.onclick=()=>{selectedRegistrationAvatar=src;renderRegistrationAvatarPicker()};grid.appendChild(b)});
}
function resetRegistrationFlow(){}
function updateRegistrationUI(){
  $("authBtn").textContent=registering?"Зарегистрироваться":"Войти";
}
let rewardState={oranges:0,rewards:[],captcha:null};
async function loadRewards(){
  try{ rewardState=await api('/api/rewards'); renderRewards(); }catch(e){ console.debug('rewards:',e.message); }
}
function openRewards(){
  $('rewardsModal').style.display='grid';
  $('captchaBox').style.display='none';
  loadRewards();
}
function closeRewards(){ $('rewardsModal').style.display='none'; }
function renderRewards(){
  $('rewardBalance').textContent=`🍊 ${Number(rewardState.oranges||0)}`;
  const cards=$('rewardCards'); if(!cards)return;
  cards.innerHTML=(rewardState.rewards||[]).map(r=>{
    const owned=!!r.owned, unlocked=Number(rewardState.oranges||0)>=Number(r.unlockAt);
    return `<div class="reward-card ${owned?'':'locked'}">
      <img src="${escapeHtml(r.stickerSrc)}" alt="Стикер ${r.stickerId}">
      <b>${r.stickerId===30?'Королевская капибара':'Капибара и Туф'}</b>
      <div class="reward-sub" style="margin:5px 0">${owned?'Получен':`Нужно ${r.unlockAt} 🍊`}</div>
      ${owned?`<button type="button" onclick="addRewardToProfile(${r.stickerId})">🎁 Добавить в профиль</button>`:''}
    </div>`;
  }).join('');
}
async function addRewardToProfile(stickerId){
  try{ await api('/api/stickers/'+Number(stickerId)+'/profile',{method:'POST'}); await loadRewards(); alert('Стикер добавлен в подарки профиля.'); }
  catch(e){ alert(e.message||'Не удалось добавить подарок'); }
}
async function startCaptcha(){
  try{
    const d=await api('/api/captcha/challenge',{method:'POST'});
    rewardState.captcha=d;
    $('captchaBox').style.display='block';
    $('captchaExpression').textContent=d.expression||'Решите задачу';
    const box=$('captchaOptions');
    box.innerHTML=(d.options||[]).map(v=>`<button class="captcha-option" type="button" onclick="verifyCaptcha(${Number(v)})">${escapeHtml(String(v))}</button>`).join('');
    $('captchaHint').textContent='Сложность: высокая • за правильный ответ +5 🍊 • каждый раз новое задание';
  }catch(e){alert(e.message||'Не удалось создать CAPTCHA');}
}
async function verifyCaptcha(answer){
  const c=rewardState.captcha; if(!c)return;
  try{
    const d=await api('/api/captcha/verify',{method:'POST',body:{token:c.token,answer:Number(answer)}});
    rewardState.oranges=Number(d.oranges||0); rewardState.rewards=d.rewards||[];
    $('captchaBox').style.display='none';
    renderRewards();
    alert('Верно! +5 🍊');
  }catch(e){
    $('captchaHint').textContent='Неверно. Получите новую CAPTCHA и попробуйте ещё раз.';
    $('captchaHint').style.color='#ff9a9a';
    setTimeout(()=>startCaptcha(),450);
  }
}

function renderRegistrationAvatarPicker(){
  const picker=$("registerAvatarPicker"), grid=$("registerAvatarGrid"), selected=$("registerAvatarSelected");
  if(!picker||!grid||!selected)return;
  picker.classList.toggle("show",registering);
  grid.innerHTML="";
  if(selectedRegistrationAvatar){
    selected.innerHTML=`<img src="${selectedRegistrationAvatar}" alt=""><span>Выбранная аватарка</span>`;
  }else{
    selected.innerHTML="<span>Аватарка не выбрана</span>";
  }
  REGISTRATION_AVATARS.forEach((src,i)=>{
    const b=document.createElement("button"); b.type="button"; b.className="auth-avatar-item"+(selectedRegistrationAvatar===src?" selected":"");
    b.title=`Аватарка ${i+1}`;
    const img=document.createElement("img"); img.src=src; img.alt=`Аватарка ${i+1}`;
    b.appendChild(img);
    b.onclick=()=>{selectedRegistrationAvatar=src;renderRegistrationAvatarPicker();};
    grid.appendChild(b);
  });
}

function resetRegistrationFlow(){
  ["login","pass","registerEmail"].forEach(id=>{const el=$(id);if(el){el.disabled=false;el.readOnly=false;}});
}
function updateRegistrationUI(){
  const wrap=$("registerEmailWrap"); if(wrap)wrap.style.display=registering?"block":"none";
  $("authBtn").textContent=registering?"Создать аккаунт":"Войти";
}
function toggleAuth(){
  registering=!registering; resetRegistrationFlow();
  $("authTitle").textContent=registering?"Регистрация":"Вход";
  $("switch").textContent=registering?"Уже есть аккаунт? Войти":"Нет аккаунта? Регистрация";
  $("err").textContent=""; selectedRegistrationAvatar=""; renderRegistrationAvatarPicker(); updateRegistrationUI(); toggleProtectedCode();
}

async function api(path, options={}){
  const saved=sessionStorage.getItem("bkt_token");
  if(saved) token=saved;
  const headers={...(options.headers||{})};
  if(token) headers.Authorization="Bearer "+token;
  if(options.body && typeof options.body!=="string"){
    headers["Content-Type"]="application/json";
    options={...options,body:JSON.stringify(options.body)};
  }
  const res=await fetch(path,{...options,headers});
  const text=await res.text();
  let data={};
  try{ data=text?JSON.parse(text):{}; }catch(_){ throw new Error("Сервер вернул неверный ответ ("+res.status+")"); }
  if(!res.ok) throw new Error(data.error||data.message||("Ошибка "+res.status));
  return data;
}


async function authAction(){
  const username=$("login").value.trim();
  const password=$("pass").value;
  $("err").textContent="";
  if(!username||!password){$("err").textContent="Введите логин и пароль";return;}
  if(!registering){
    try{
      const d=await api("/api/login",{method:"POST",body:{username,password,accessCode:$("accessCode").value.trim()}});
      token=d.token; sessionStorage.setItem("bkt_token",token); await start();
    }catch(e){$("err").textContent=e.message||"Ошибка авторизации";}
    return;
  }
  if(!selectedRegistrationAvatar){ selectedRegistrationAvatar=REGISTRATION_AVATARS[0]; }
  const email=$("registerEmail").value.trim();
  if(!email){$("err").textContent="Введите email";return;}
  try{
    const d=await api("/api/register",{method:"POST",body:{username,email,password,accessCode:$("accessCode").value.trim(),avatar:selectedRegistrationAvatar}});
    token=d.token; sessionStorage.setItem("bkt_token",token); await start();
  }catch(e){$("err").textContent=e.message||"Ошибка регистрации";}
}

async function start(){
  if(!token) return;
  try{
    me=await api("/api/me");
    $("auth").style.display="none";
    $("app").style.display="grid";
    $("me").textContent="@"+(me.username||"");
    connectSocket();
    loadUsers();
    loadRewards();
    loadGroups();
    updateNotifyButton();
    if("Notification" in window && Notification.permission === "granted") setupPush().catch(()=>{});
  }catch(e){
    sessionStorage.removeItem("bkt_token");
    token=null;
    me=null;
    $("app").style.display="none";
    $("auth").style.display="grid";
    $("err").textContent="";
  }
}

function toggleAuth(){registering=!registering;resetRegistrationFlow();$("authTitle").textContent=registering?"Регистрация":"Вход";$("switch").textContent=registering?"Уже есть аккаунт? Войти":"Нет аккаунта? Регистрация";$("err").textContent="";selectedRegistrationAvatar="";renderRegistrationAvatarPicker();updateRegistrationUI();toggleProtectedCode();}
async function api(path, options={}){
  const saved=sessionStorage.getItem("bkt_token"); if(saved) token=saved;
  const headers={...(options.headers||{})}; if(token) headers.Authorization="Bearer "+token;
  if(options.body && typeof options.body!=="string"){headers["Content-Type"]="application/json";options={...options,body:JSON.stringify(options.body)}}
  const res=await fetch(path,{...options,headers}); const text=await res.text(); let data={}; try{data=text?JSON.parse(text):{}}catch(_){throw new Error("Сервер вернул неверный ответ ("+res.status+")")}
  if(!res.ok)throw new Error(data.error||data.message||("Ошибка "+res.status)); return data;
}
async function authAction(){
  const username=$("login").value.trim(), password=$("pass").value; $("err").textContent="";
  if(!username||!password){$("err").textContent="Введите логин и пароль";return;}
  if(!registering){try{const d=await api("/api/login",{method:"POST",body:{username,password,accessCode:$("accessCode").value.trim()}});token=d.token;sessionStorage.setItem("bkt_token",token);await start()}catch(e){$("err").textContent=e.message||"Ошибка авторизации"}return}
  if(!selectedRegistrationAvatar)selectedRegistrationAvatar=REGISTRATION_AVATARS[0];
  try{const d=await api("/api/register",{method:"POST",body:{username,password,accessCode:$("accessCode").value.trim(),avatar:selectedRegistrationAvatar}});token=d.token;sessionStorage.setItem("bkt_token",token);await start()}catch(e){$("err").textContent=e.message||"Ошибка регистрации"}
}

async function start(){
  if(!token) return;
  try{
    me=await api("/api/me");
    $("auth").style.display="none";
    $("app").style.display="grid";
    $("me").textContent="@"+(me.username||"");
    connectSocket();
    loadUsers();
    loadRewards();
    loadGroups();
    updateNotifyButton();
    if("Notification" in window && Notification.permission === "granted") setupPush().catch(()=>{});
  }catch(e){
    sessionStorage.removeItem("bkt_token");
    token=null;
    me=null;
    $("app").style.display="none";
    $("auth").style.display="grid";
    $("err").textContent=e.message||"Не удалось войти в аккаунт";
  }
}

let toastTimer=null;
let toastUserId=null;

function updateNotifyButton(){
  const b=$("notifyBtn"); if(!b) return;
  if(!("Notification" in window)){ b.textContent="🔔 Уведомления недоступны"; b.disabled=true; return; }
  b.textContent = Notification.permission === "granted" ? "🔔 Уведомления включены" : "🔔 Включить уведомления";
}

let pushRegistration=null;

function urlBase64ToUint8Array(base64String){
  const padding="=".repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,"+").replace(/_/g,"/");
  const raw=atob(base64);
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

async function setupPush(){
  if(!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  pushRegistration=await navigator.serviceWorker.register("/sw.js");
  let sub=await pushRegistration.pushManager.getSubscription();
  if(!sub){
    const r=await api("/api/push/public-key");
    sub=await pushRegistration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(r.publicKey)});
  }
  await api("/api/push/subscribe",{method:"POST",body:JSON.stringify(sub.toJSON())});
  return true;
}

async function enableNotifications(){
  if(!window.isSecureContext){ alert("Для push-уведомлений нужен HTTPS (или localhost)."); return; }
  if(!("Notification" in window)){ alert("Этот браузер не поддерживает уведомления."); return; }
  try{
    const permission=await Notification.requestPermission();
    if(permission==="granted") await setupPush();
    updateNotifyButton();
  }catch(e){ console.error(e); alert("Не удалось включить push-уведомления."); }
}

function notifyIncomingMessage(message){
  const isMine = Number(message.sender_id)===Number(me?.id);
  if(isMine) return;
  const isOpen = selected && Number(selected.id)===Number(message.sender_id) && document.visibilityState === "visible";
  if(isOpen) return;
  const name = message.sender_name || "Новое сообщение";
  toastUserId = Number(message.sender_id);
  const toast=$("bktToast");
  if(toast){ toast.innerHTML=`<b>💬 ${escapeHtml(name)}</b><span>${escapeHtml(message.text||"Новое сообщение")}</span>`; toast.style.display="block"; clearTimeout(toastTimer); toastTimer=setTimeout(()=>toast.style.display="none",5000); }
  if("Notification" in window && Notification.permission === "granted"){
    try{
      const n=new Notification(name,{body:message.text||"Новое сообщение",tag:"bkt-message-"+message.sender_id});
      n.onclick=()=>{window.focus(); if(toastUserId){loadUserAndOpen(toastUserId);} n.close();};
    }catch(e){}
  }
}

async function loadUserAndOpen(userId){
  try{ const list=await api("/api/users/search?q="+encodeURIComponent(String(userId))); }catch(_){}
  const users=await api("/api/users").catch(()=>[]);
  const u=users.find(x=>Number(x.id)===Number(userId));
  if(u) openUser(u);
}

async function loadPendingCalls(){
  try{
    const calls=await api("/api/calls/pending");
    if(Array.isArray(calls) && calls.length && !incomingCall){
      const c=calls[0];
      handleCallSignal({type:"call-signal",signalType:"offer",callId:c.id,fromUserId:c.caller_id,fromUsername:c.caller_username,signal:c.offer,callType:c.call_type,iceCandidates:c.iceCandidates||[]});
    }
  }catch(e){}
}

let callPollTimer=null;
let socketReconnectTimer=null;
let socketReconnectDelay=1000;
const presenceState=new Map();
function startCallPolling(){
  clearInterval(callPollTimer);
  callPollTimer=setInterval(async()=>{
    if(document.hidden && !incomingCall) return;
    await loadPendingCalls();
  }, 3000);
}

function updatePresenceUI(userId, online){
  const id=Number(userId);
  presenceState.set(id, !!online);
  document.querySelectorAll('[data-user-id=\"'+id+'\"]').forEach(row=>{
    const dot=row.querySelector('.presence-dot');
    const label=row.querySelector('.presence-label');
    if(dot){dot.className='presence-dot '+(online?'online':'offline');dot.textContent='●';}
    if(label) label.innerHTML='<span class="presence-dot '+(online?'online':'offline')+'">●</span>'+(online?'онлайн':'не в сети');
  });
  if(selected && Number(selected.id)===id){
    selected.online=!!online;
    const hs=$('headStatus');
    if(hs) hs.innerHTML=online?' <span class="presence-dot online">●</span> онлайн':' <span class="presence-dot offline">●</span> не в сети';
  }
}

function applyOnlineList(ids){
  presenceState.clear();
  (Array.isArray(ids)?ids:[]).forEach(id=>presenceState.set(Number(id),true));
  document.querySelectorAll('[data-user-id]').forEach(row=>{
    const id=Number(row.getAttribute('data-user-id'));
    updatePresenceUI(id,presenceState.get(id)===true);
  });
}

function setMessageRead(id, read){
  const el=document.getElementById('m'+id);
  const status=el?.querySelector('.message-status');
  if(status){status.className='message-status '+(read?'read':'unread');status.textContent='✓';status.title=read?'Прочитано':'Отправлено, не прочитано';}
}

async function markSelectedChatRead(){
  if(!selected || activeGroup || document.visibilityState!=='visible') return;
  try{
    const result=await api('/api/messages/'+selected.id+'/read',{method:'POST'});
    (result.ids||[]).forEach(id=>setMessageRead(id,true));
  }catch(e){console.debug('read receipt:',e.message)}
}

function scheduleSocketReconnect(){
  if(socketReconnectTimer || !token) return;
  socketReconnectTimer=setTimeout(()=>{socketReconnectTimer=null;connectSocket();},socketReconnectDelay);
  socketReconnectDelay=Math.min(socketReconnectDelay*2,10000);
}

function connectSocket(){
  try{ if(socket) socket.close(); }catch(_){}
  const scheme=location.protocol==='https:'?'wss://':'ws://';
  socket=new WebSocket(scheme+location.host+'/?token='+encodeURIComponent(token));
  socket.onopen=()=>{socketReconnectDelay=1000;loadPendingCalls();startCallPolling();};
  socket.onmessage=e=>{
    try{
      const d=JSON.parse(e.data);
      if(d.type==='connected'){applyOnlineList(d.onlineUserIds||[]);if(selected)updatePresenceUI(selected.id,presenceState.get(Number(selected.id))===true);return;}
      if(d.type==='presence'){updatePresenceUI(d.userId,d.online);return;}
      if(d.type==='messages-read'){(d.messageIds||[]).forEach(id=>setMessageRead(id,true));return;}
      if(d.type==='call-signal'){handleCallSignal(d);return;}
      if(d.type==='call-history' && d.message){if(selected&&(Number(d.message.sender_id)===Number(selected.id)||Number(d.message.receiver_id)===Number(selected.id)))renderMessage(d.message);return;}
      if(d.type==='message' && d.message){
        notifyIncomingMessage(d.message);
        if(selected&&(Number(d.message.sender_id)===Number(selected.id)||Number(d.message.receiver_id)===Number(selected.id))){
          renderMessage(d.message);
          if(Number(d.message.sender_id)!==Number(me?.id)&&document.visibilityState==='visible')markSelectedChatRead();
        }
        if(Number(d.message.sender_id)!==Number(me?.id))maybeOpenBktGame(d.message.text,true);
        return;
      }
      if(d.type==='message-deleted'){const el=document.getElementById('m'+d.messageId);if(el)el.remove();return;}
      if(d.type==='account-deleted'){ sessionStorage.removeItem("bkt_token"); token=null; me=null; alert("Ваш аккаунт был удалён навсегда."); location.reload(); return; }
      if(d.type==='group-message'&&d.message&&activeGroup&&Number(d.message.group_id)===Number(activeGroup.id)){renderGroupMessage(d.message);if(Number(d.message.sender_id)!==Number(me?.id))maybeOpenBktGame(d.message.text,true);return;}
      if(d.type==='group-message-deleted'){const el=document.getElementById('gm'+d.messageId);if(el)el.remove();return;}
    }catch(err){console.error('WebSocket message error:',err);}
  };
  socket.onclose=()=>{if(token)scheduleSocketReconnect();};
  socket.onerror=()=>{};
}

function verifiedName(name, verified){
  const safe=escapeHtml(String(name||""));
  return safe+(verified?'<span class="verified-badge" title="Подтверждено">✓</span>':"");
}

async function loadUsers(){
  const input = $("search");
  const q = (input?.value || "").trim().replace(/^@+/,"");
  const box = $("users");
  if (!box) return;

  try {
    const list = q
      ? await api("/api/users/search?q="+encodeURIComponent(q))
      : await api("/api/users");
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = q
        ? '<div style="padding:14px;color:#8d9893">Никого не найдено. Проверь @username.</div>'
        : '<div style="padding:14px;color:#8d9893">Пока нет чатов.</div>';
      return;
    }

    for (const u of list) {
      const row = document.createElement("div");
      row.className = "user";
      row.dataset.userId = String(u.id);
      row.onclick = () => openUser(u);
      const initial = escapeHtml((u.username || "?")[0].toUpperCase());
      const avatar = u.avatar
        ? `<img src="${escapeHtml(u.avatar)}" style="width:42px;height:42px;border-radius:50%;object-fit:cover">`
        : initial;
      const online = presenceState.has(Number(u.id)) ? presenceState.get(Number(u.id)) : !!u.online;
      presenceState.set(Number(u.id), online);
      row.innerHTML =
        `<div class="avatar">${avatar}</div>` +
        `<div><b>${verifiedName(u.username, !!u.verified)}</b><small>@${escapeHtml(u.username)}</small><small class="presence-label" style="display:block;color:${online?'#22ff72':'#68736d'}"> <span class="presence-dot ${online?'online':'offline'}">●</span>${online?'онлайн':'не в сети'}</small></div>`;
      box.appendChild(row);
    }
  } catch(e) {
    box.innerHTML = '<div style="padding:14px;color:#ff8d8d">'+escapeHtml(e.message||"Ошибка поиска")+'</div>';
  }
}
function updateComposerAccess(){
  const readonly = !!(activeGroup && activeGroup.name === "БКТ Сообщество" && !["brozi","vlad"].includes(String(me?.username || "").toLowerCase()));
  const ids=["voiceButton","videoNoteButton","stickerButton","text"];
  ids.forEach(id=>{const el=$(id);if(!el)return;el.disabled=readonly;el.style.opacity=readonly?".45":"";el.style.cursor=readonly?"not-allowed":"";});
  const send=$('.send');
  if(send){send.disabled=readonly;send.style.opacity=readonly?".45":"";send.style.cursor=readonly?"not-allowed":"";}
  const notice=$("communityReadonly");
  if(notice) notice.style.display=readonly?"block":"none";
}

async function loadGroups(){
 try{const gs=await api('/api/groups');$("groups").innerHTML=gs.map(g=>`<div class="group-item" onclick='openGroup(${JSON.stringify(g)})'>👥 ${escapeHtml(g.name)}<small style="display:block;color:#8d9893">${Array.isArray(g.members) ? g.members.length : 1} участников</small></div>`).join('')}catch(e){console.error(e)}
}
async function createGroup(){
 const name=prompt('Название группы:'); if(!name||!name.trim())return;
 const raw=prompt('Введите @username участников через запятую:')||''; const ids=[];
 for(const n0 of raw.split(',')){const n=n0.trim().replace(/^@+/,'');if(!n)continue;try{const a=await api('/api/users?q='+encodeURIComponent(n));const u=a.find(x=>x.username.toLowerCase()===n.toLowerCase())||a[0];if(u)ids.push(u.id)}catch{}}
 try{const g=await api('/api/groups',{method:'POST',body:JSON.stringify({name:name.trim(),memberIds:ids})});openGroup(g);loadGroups()}catch(e){alert(e.message)}
}
async function openGroup(g){activeGroup=g;selected=null;$("app").classList.add('mobile-chat');$("headName").textContent=g.name;$("headAvatar").textContent='👥';$("headStatus").textContent=` ${g.members.length} участников`;updateComposerAccess();loadChatWallpaper();const ms=await api('/api/groups/'+g.id+'/messages');$("messages").innerHTML='';ms.forEach(renderGroupMessage)}
function renderGroupMessage(m){
  if($("gm"+m.id))return;
  const d=document.createElement("div"); d.id="gm"+m.id; d.className="bubble "+(Number(m.sender_id)===Number(me.id)?"me":"");
  const w=document.createElement("div"); w.style.fontSize="12px"; w.style.opacity=".7"; w.textContent=m.sender_name; d.appendChild(w);
  if(String(m.text).startsWith("[STICKER]")){
    const img=document.createElement("img");
    img.className="sticker-msg";
    img.alt="Стикер Туф";
    img.src=String(m.text).substring(9);
    img.loading="lazy";
    d.classList.add("sticker-bubble");
    d.appendChild(img);
  } else {
    const t=document.createElement("div"); t.textContent=m.text; d.appendChild(t);
  }
  const meta=document.createElement("div"); meta.style.display="flex"; meta.style.justifyContent="flex-end"; meta.style.gap="6px";
  if(Number(m.sender_id)===Number(me.id)){
    const del=document.createElement("button"); del.type="button"; del.title="Удалить сообщение"; del.textContent="×";
    del.style.cssText="border:0;background:transparent;color:#a1b0a7;cursor:pointer;font-size:16px;padding:0 2px";
    del.onclick=()=>deleteGroupMessage(m.id); meta.appendChild(del);
  }
  d.appendChild(meta); $("messages").appendChild(d); $("messages").scrollTop=$("messages").scrollHeight;
}
async function deleteGroupMessage(id){
  if(!confirm("Удалить это сообщение?"))return;
  try{await api("/api/groups/messages/"+id,{method:"DELETE"});const el=$("gm"+id);if(el)el.remove();}
  catch(e){alert(e.message||"Не удалось удалить сообщение");}
}
async function openUser(u){activeGroup=null;selected=u;$('app').classList.add('mobile-chat');$('headName').textContent=u.username;$('headAvatar').textContent=u.username[0].toUpperCase();const online=presenceState.has(Number(u.id))?presenceState.get(Number(u.id)):!!u.online;$('headStatus').innerHTML=online?' <span class="presence-dot online">●</span> онлайн':' <span class="presence-dot offline">●</span> не в сети';updateComposerAccess();let ms=await api("/api/messages/"+u.id);$('messages').innerHTML="";ms.forEach(renderMessage);$('messages').scrollTop=$('messages').scrollHeight;await markSelectedChatRead();loadUsers()}
  loadChatWallpaper();
function renderMessage(m){
  if(document.getElementById("m"+m.id))return;
  const d=document.createElement("div");
  d.id="m"+m.id;
  d.className="bubble "+(Number(m.sender_id)===Number(me.id)?"me":"");

  if(String(m.text).startsWith("[STICKER]")){
    const src=String(m.text).substring(9);
    const img=document.createElement("img");
    img.className="sticker-msg";
    img.alt="Стикер Туф";
    img.src=src;
    img.loading="lazy";
    d.classList.add("sticker-bubble");
    d.appendChild(img);
  } else if(m.text.startsWith("[VOICE]")){
    const audio=document.createElement("audio");
    audio.controls=true; audio.preload="metadata"; audio.src=m.text.substring(7);
    audio.style.maxWidth="230px"; d.appendChild(audio);
  } else if(m.text.startsWith("[VIDEO_NOTE]")){
    const video=document.createElement("video");
    video.controls=true; video.playsInline=true; video.preload="metadata";
    video.src=m.text.substring(12); video.style.width="180px"; video.style.height="180px";
    video.style.objectFit="cover"; video.style.borderRadius="50%"; video.style.display="block";
    d.appendChild(video);
  } else if(m.text.startsWith("[IMAGE]")){
    const img=document.createElement("img"); img.className="chat-media"; img.loading="lazy"; img.src=m.text.substring(7); img.alt="Фото"; d.appendChild(img);
  } else if(m.text.startsWith("[VIDEO]")){
    const video=document.createElement("video"); video.className="chat-media"; video.controls=true; video.playsInline=true; video.preload="metadata"; video.src=m.text.substring(7); d.appendChild(video);
  } else {
    const body=document.createElement("div");
    body.textContent=m.text;
    if(String(m.text).startsWith("📞") || String(m.text).startsWith("📹")) d.classList.add("call-history");
    d.appendChild(body);
  }

  const meta=document.createElement("div");
  meta.style.display="flex"; meta.style.alignItems="center"; meta.style.justifyContent="flex-end"; meta.style.gap="6px";
  const t=document.createElement("time");
  t.textContent=formatMessageTime(m.created_at);
  meta.appendChild(t);
  if(Number(m.sender_id)===Number(me.id)){
    const status=document.createElement("span");
    status.className='message-status '+(m.read_at?'read':'unread');
    status.textContent='✓';
    status.title=m.read_at?'Прочитано':'Отправлено, не прочитано';
    meta.appendChild(status);
  }
  if(Number(m.sender_id)===Number(me.id)){
    const del=document.createElement("button");
    del.type="button"; del.title="Удалить сообщение"; del.textContent="×";
    del.style.cssText="border:0;background:transparent;color:#a1b0a7;cursor:pointer;font-size:16px;padding:0 2px;line-height:1";
    del.onclick=()=>deleteMessage(m.id);
    meta.appendChild(del);
  }
  d.appendChild(meta);
  $("messages").appendChild(d);
  $("messages").scrollTop=$("messages").scrollHeight;
}

async function deleteMessage(id){
  if(!confirm("Удалить это сообщение?"))return;
  try{
    await api("/api/messages/"+id,{method:"DELETE"});
    const el=document.getElementById("m"+id); if(el) el.remove();
  }catch(e){alert(e.message||"Не удалось удалить сообщение");}
}


function maybeOpenBktGame(text, isIncoming=false){
  const normalized=String(text||"").trim().toLowerCase();
  if(normalized==="бкт игра") {
    window.open("https://vladplaygh2.github.io/ctcapp/ctc.html", "_blank", "noopener,noreferrer");
  }
}

function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function mobileBack(){$("app").classList.remove("mobile-chat");loadUsers();}


let voiceRecorder=null, voiceChunks=[], voiceStream=null, voiceTimer=null, voiceSeconds=0;
let videoRecorder=null, videoChunks=[], videoStream=null, videoTimer=null, videoSeconds=0;

if(document.getElementById("voiceButton"))document.getElementById("voiceButton").addEventListener("click", startVoiceRecording);
if(document.getElementById("videoNoteButton"))document.getElementById("videoNoteButton").addEventListener("click", startVideoRecording);

function pickMime(types){
  return types.find(x=>MediaRecorder.isTypeSupported(x)) || "";
}

async function startVoiceRecording(){
  if(activeGroup)return alert("Голосовые сообщения в группах пока недоступны");
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
  if(activeGroup)return alert("Видеосообщения в группах пока недоступны");
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


function wallpaperKey(){ return activeGroup ? "group:"+activeGroup.id : (selected ? "user:"+selected.id : "none"); }
function applyWallpaperValue(value){ const v=(value||"").trim(); const el=$("messages"); if(!el)return; if(!v){el.style.background="";return;} const isColor=/^#[0-9a-f]{3,8}$/i.test(v); el.style.background=isColor?v:`linear-gradient(rgba(2,4,3,.35),rgba(2,4,3,.35)),url("${v.replace(/"/g,'\\"')}") center/cover fixed`; }
function loadChatWallpaper(){ const key=wallpaperKey(); if(key==="none")return; const saved=localStorage.getItem("bkt_wallpaper_"+key)||""; $("wallpaperUrl").value=saved && !/^#[0-9a-f]{3,8}$/i.test(saved)?saved:""; $("wallpaperColor").value=/^#[0-9a-f]{3,8}$/i.test(saved)?saved:"#08100c"; applyWallpaperValue(saved); }
function applyChatWallpaper(){ const v=$("wallpaperUrl").value.trim() || $("wallpaperColor").value; if(wallpaperKey()==="none")return; localStorage.setItem("bkt_wallpaper_"+wallpaperKey(),v); applyWallpaperValue(v); }
function clearChatWallpaper(){ if(wallpaperKey()!=="none")localStorage.removeItem("bkt_wallpaper_"+wallpaperKey()); $("wallpaperUrl").value=""; $("wallpaperColor").value="#08100c"; applyWallpaperValue(""); }
async function openProfileView(userId, isMe=false){
  try{
    const p = isMe ? await api("/api/profile") : await api("/api/users/"+encodeURIComponent(userId)+"/profile");
    $("profileViewName").innerHTML = verifiedName(p.username, !!p.verified);
    $("profileViewUsername").textContent = "@"+p.username;
    $("profileViewBio").textContent = p.bio || "О себе пока ничего не указано.";
    const giftsBox=$("profileViewGifts");
    if(giftsBox){
      const gifts=Array.isArray(p.gifts)?p.gifts:[];
      giftsBox.innerHTML=gifts.length ? gifts.map(g=>`<div class="reward-card"><img src="${escapeHtml(g.src)}" alt="Подарок"><div class="reward-sub">🎁 Подарок</div></div>`).join('') : `<div class="reward-sub" style="grid-column:1/-1;padding:8px">Подарков пока нет</div>`;
    }
    const av=$("profileViewAvatar");
    av.innerHTML="";
    if(p.avatar){
      const img=document.createElement("img"); img.src=p.avatar; img.alt=""; av.appendChild(img);
    }else{
      av.textContent=(p.username||"?")[0].toUpperCase();
    }
    $("profileViewChat").style.display = isMe ? "none" : "block";
    const giftActions=$("profileViewGiftActions");
    if(giftActions){
      const owned=!isMe ? [...(ownedRewardStickerIds||[])].filter(id=>id===29||id===30) : [];
      giftActions.innerHTML=owned.map(id=>`<button type="button" onclick="giftRewardTo(${Number(p.id)},${id})">🎁 Подарить ${id===30?'👑':'🍊'}</button>`).join('');
      giftActions.style.display=owned.length?'flex':'none';
    }
    const blockBtn=$("profileViewBlock"), blockState=$("profileViewBlockState"), deleteBtn=$("profileViewDelete");
    if(deleteBtn){
      const canDelete = !isMe && ["brozi","vlad"].includes(String(me?.username||"").toLowerCase()) && !["brozi","vlad"].includes(String(p.username||"").toLowerCase());
      deleteBtn.style.display = canDelete ? "block" : "none";
    }
    if(isMe){
      blockBtn.style.display="none"; blockState.textContent="";
    }else{
      blockBtn.style.display="block"; blockBtn.disabled=false;
      try{
        const bs=await api("/api/users/"+encodeURIComponent(p.id)+"/block-status");
        window.profileViewBlockStatus=bs;
        if(bs.blocked){
          blockBtn.textContent="🔓 Разблокировать"; blockBtn.className="blocked";
          blockState.textContent="Вы заблокировали этого пользователя.";
        }else if(bs.blockedByUser){
          blockBtn.style.display="none"; blockState.textContent="Этот пользователь заблокировал вас.";
        }else{
          blockBtn.textContent="🚫 Заблокировать"; blockBtn.className="danger"; blockState.textContent="";
        }
      }catch(_){ blockBtn.textContent="🚫 Заблокировать"; blockBtn.className="danger"; }
    }
    $("profileViewModal").style.display="grid";
    window.profileViewUser = isMe ? null : p;
  }catch(e){ alert(e.message || "Не удалось открыть профиль"); }
}
async function giftRewardTo(receiverId, stickerId){
  try{ await api('/api/stickers/'+Number(stickerId)+'/send',{method:'POST',body:{receiverId:Number(receiverId)}}); alert('Подарок отправлен.'); }
  catch(e){ alert(e.message||'Не удалось отправить подарок'); }
}
async function deleteAccountPermanently(){
  const p=window.profileViewUser;
  if(!p || !["brozi","vlad"].includes(String(me?.username||"").toLowerCase())) return;
  if(["brozi","vlad"].includes(String(p.username||"").toLowerCase())) return;
  if(!confirm(`Удалить @${p.username} навсегда?\n\nАккаунт, сообщения, статусы и данные будут удалены, а логин больше нельзя будет зарегистрировать.`)) return;
  try{
    await api("/api/admin/users/"+encodeURIComponent(p.id),{method:"DELETE"});
    if(selected && Number(selected.id)===Number(p.id)){
      selected=null; activeGroup=null;
      $("headName").textContent="Выберите чат"; $("headStatus").textContent="";
      $("messages").innerHTML='<div class="empty">Аккаунт удалён</div>';
      $("app").classList.remove("mobile-chat");
    }
    closeProfileView();
    loadUsers();
    alert("Аккаунт удалён навсегда.");
  }catch(e){alert(e.message||"Не удалось удалить аккаунт");}
}

async function toggleProfileBlock(){
  const p=window.profileViewUser; if(!p)return;
  const bs=window.profileViewBlockStatus||{};
  if(!confirm(`${bs.blocked?"Разблокировать":"Заблокировать"} @${p.username}?`))return;
  try{
    await api("/api/users/"+encodeURIComponent(p.id)+"/block",{method:bs.blocked?"DELETE":"POST"});
    await openProfileView(p.id,false);
    if(!bs.blocked && selected && Number(selected.id)===Number(p.id)){
      selected=null; activeGroup=null;
      $("headName").textContent="Выберите чат"; $("headStatus").textContent="";
      $("messages").innerHTML='<div class="empty">Пользователь заблокирован</div>';
      $("app").classList.remove("mobile-chat");
    }
    loadUsers();
  }catch(e){alert(e.message||"Не удалось изменить блокировку");}
}
function openMyProfile(){ openProfileView(me?.id, true); }
function openSelectedProfile(){ if(selected) openProfileView(selected.id, false); }
function closeProfileView(){ $("profileViewModal").style.display="none"; window.profileViewUser=null; }
async function chatFromProfile(){
  const p=window.profileViewUser;
  closeProfileView();
  if(!p) return;
  await openUser(p);
}
async function openSettings(){
  try{
    const p = await api("/api/profile");
    $("profileUsername").value = p.username || ""; toggleProfileProtectedCode();
    $("profileBio").value = p.bio || "";
    const avatarPreview=$("profileAvatarPreview");
    avatarPreview.src = p.avatar || "/icon.svg";
    renderSettingsAvatarPicker(p.avatar || "");
    $("settingsError").style.color = "";
    $("settingsError").textContent = "";
    $("settingsModal").style.display = "grid";
  }catch(e){
    $("settingsError").textContent = e.message || "Не удалось загрузить профиль";
    $("settingsModal").style.display = "grid";
  }
}
function renderSettingsAvatarPicker(currentAvatar){
  const grid=$("settingsAvatarGrid");
  if(!grid)return;
  grid.innerHTML="";
  REGISTRATION_AVATARS.forEach((src,i)=>{
    const b=document.createElement("button"); b.type="button"; b.className="auth-avatar-item settings-avatar-item"+(currentAvatar===src?" selected":"");
    b.title=`Аватарка ${i+1}`;
    const img=document.createElement("img"); img.src=src; img.alt=`Аватарка ${i+1}`;
    b.appendChild(img);
    b.onclick=()=>{
      grid.querySelectorAll(".auth-avatar-item").forEach(x=>x.classList.remove("selected"));
      b.classList.add("selected");
      $("profileAvatarPreview").src=src;
      $("settingsAvatarPreview").value=src;
    };
    grid.appendChild(b);
  });
  $("settingsAvatarPreview").value=currentAvatar || REGISTRATION_AVATARS[0];
}
function closeSettings(){ $("settingsModal").style.display="none"; }
function toggleProfileProtectedCode(){const username=$("profileUsername").value.trim().replace(/^@+/,"").toLowerCase(); const protectedUser=["brozi","vlad","vladmobile"].includes(username); $("profileAccessCode").style.display=protectedUser?"block":"none";}
async function saveSettings(){
 try{
  const p=await api("/api/profile",{method:"PATCH",body:{
   username:$("profileUsername").value.trim(),
   accessCode:$("profileAccessCode").value.trim(),
   bio:$("profileBio").value,
   avatar:$("settingsAvatarPreview").value || REGISTRATION_AVATARS[0]
  }});
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
async function deleteOwnAccountPermanently(){
  if(!me) return;
  const username=String(me.username||"");
  const first=confirm(`Удалить аккаунт @${username} НАВСЕГДА?\n\nБудут удалены профиль, сообщения, статусы, группы и другие данные аккаунта. Это действие нельзя отменить.`);
  if(!first) return;
  const second=confirm(`Последнее подтверждение.\n\nВы точно готовы навсегда удалить @${username}?\n\nПосле удаления этот аккаунт больше не восстановить. Ваш номер телефона снова можно будет использовать при регистрации.`);
  if(!second) return;
  try{
    await api("/api/account",{method:"DELETE"});
    try{socket?.close()}catch(_){}
    sessionStorage.removeItem("bkt_token");
    token=null; me=null; selected=null; activeGroup=null;
    closeSettings();
    if($('app')) $('app').style.display='none';
    if($('auth')) $('auth').style.display='grid';
    alert("Аккаунт удалён навсегда. Номер телефона снова доступен для регистрации.");
  }catch(e){
    alert(e.message||"Не удалось удалить аккаунт");
  }
}

function logout(){
  try{socket?.close()}catch(_){}
  sessionStorage.removeItem("bkt_token");
  token=null; me=null; selected=null; activeGroup=null;
  if($("app")) $("app").style.display="none";
  if($("auth")) $("auth").style.display="grid";
}


renderRegistrationAvatarPicker();

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



const STICKERS = Array.from({length:28},(_,i)=>`/stickers/${i+1}.webp`);
let stickerPickerReady=false;
let ownedRewardStickerIds=new Set();

async function refreshOwnedRewardStickers(){
  try{
    const d=await api('/api/rewards');
    rewardState=d||rewardState;
    ownedRewardStickerIds=new Set((d.rewards||[]).filter(r=>r.owned).map(r=>Number(r.stickerId)));
  }catch(_){ ownedRewardStickerIds=new Set(); }
}
function buildStickerPicker(){
  const grid=$("stickerGrid");
  if(!grid)return;
  grid.innerHTML="";
  const list=[...STICKERS];
  if(ownedRewardStickerIds.has(29))list.push('/stickers/29.webp');
  if(ownedRewardStickerIds.has(30))list.push('/stickers/30.webp');
  list.forEach((src,i)=>{
    const b=document.createElement("button");
    b.type="button";
    b.className="sticker-item";
    b.title=src.endsWith('/29.webp')?'Наградной стикер 50 🍊':src.endsWith('/30.webp')?'Наградной стикер 150 🍊':'Туф';
    b.setAttribute('aria-label',b.title);
    const img=document.createElement("img");
    img.src=src; img.alt=b.title; img.loading="lazy";
    b.appendChild(img);
    b.onclick=()=>sendSticker(src);
    grid.appendChild(b);
  });
  stickerPickerReady=true;
}
function positionStickerPicker(){
  const picker=$("stickerPicker"), btn=$("stickerButton");
  if(!picker||!btn)return;
  if(window.matchMedia("(max-width:700px)").matches){picker.style.left="";picker.style.top="";return;}
  const r=btn.getBoundingClientRect();
  const width=Math.min(390,window.innerWidth-24);
  picker.style.left=Math.max(12,Math.min(window.innerWidth-width-12,r.right-width))+"px";
  picker.style.top=Math.max(12,r.top-Math.min(520,window.innerHeight*.65)-8)+"px";
}
async function toggleStickerPicker(){
  if(!selected && !activeGroup){alert("Сначала выберите чат");return;}
  await refreshOwnedRewardStickers();
  buildStickerPicker();
  const p=$("stickerPicker");
  const open=p.style.display==="block";
  p.style.display=open?"none":"block";
  if(!open)positionStickerPicker();
}
function closeStickerPicker(){if($("stickerPicker"))$("stickerPicker").style.display="none";}
async function sendSticker(src){
  if(activeGroup && activeGroup.name === "БКТ Сообщество" && !["brozi","vlad"].includes(String(me?.username || "").toLowerCase())){alert("В этой группе могут писать только Brozi и Vlad");return;}
  if(!selected && !activeGroup)return;
  closeStickerPicker();
  const text="[STICKER]"+src;
  try{
    if(activeGroup){
      const msg=await api("/api/groups/"+activeGroup.id+"/messages",{method:"POST",body:{text}});
      renderGroupMessage(msg);
    }else{
      const msg=await api("/api/messages",{method:"POST",body:{receiverId:Number(selected.id),text}});
      renderMessage(msg);
    }
  }catch(e){alert(e.message||"Не удалось отправить стикер");}
}
$("stickerButton").onclick=toggleStickerPicker;
$("stickerClose").onclick=closeStickerPicker;
document.addEventListener("click",e=>{
  const p=$("stickerPicker"), b=$("stickerButton");
  if(p && p.style.display==="block" && !p.contains(e.target) && e.target!==b)closeStickerPicker();
});
window.addEventListener("resize",()=>{if($("stickerPicker")?.style.display==="block")positionStickerPicker();});

async function sendChatMedia(file){
  if(!file || !selected || activeGroup) return;
  const isImage=file.type.startsWith("image/");
  const isVideo=file.type.startsWith("video/");
  if(!isImage && !isVideo){alert("Можно отправлять только фото или видео");return;}
  const max=isVideo?25*1024*1024:12*1024*1024;
  if(file.size>max){alert(`Файл слишком большой. Максимум ${isVideo?25:12} МБ.`);return;}
  try{
    const fd=new FormData(); fd.append("media",file); fd.append("receiverId",String(selected.id)); fd.append("kind",isImage?"image":"video");
    const headers={}; if(token) headers.Authorization="Bearer "+token;
    const res=await fetch("/api/media",{method:"POST",headers,body:fd});
    const data=await res.json(); if(!res.ok) throw new Error(data.error||"Не удалось отправить файл");
    renderMessage(data);
  }catch(e){alert(e.message||"Не удалось отправить файл");}
}

async function send(){
  const input=$("text"), text=input.value.trim();
  if(activeGroup && activeGroup.name === "БКТ Сообщество" && !["brozi","vlad"].includes(String(me?.username || "").toLowerCase())){alert("В этой группе могут писать только Brozi и Vlad");return;}
  if(!text)return;
  if(activeGroup){
    try{
      const msg=await api("/api/groups/"+activeGroup.id+"/messages",{method:"POST",body:{text}});
      input.value="";
      renderGroupMessage(msg);
      maybeOpenBktGame(msg.text);
    }catch(e){alert(e.message||"Не удалось отправить сообщение")}
    return;
  }
  if(!selected){alert("Сначала выберите чат");return}
  try{
    const msg=await api("/api/messages",{method:"POST",body:{receiverId:Number(selected.id),text}});
    input.value="";
    renderMessage(msg);
    maybeOpenBktGame(msg.text);
  }catch(e){alert(e.message||"Не удалось отправить сообщение")}
}


let peer=null, localCallStream=null, incomingCall=null, callType="audio", pendingIceCandidates=[], incomingIceCandidates=[], callPeerUserId=null, localCallId=null, callTimeout=null; let callMicEnabled=true, callCameraEnabled=true;

function callSocket(data){
  if(!socket || socket.readyState!==WebSocket.OPEN){
    throw new Error("Нет соединения с сервером. Перезагрузи страницу.");
  }
  socket.send(JSON.stringify(data));
}

async function startCall(type){
  if(!selected)return alert("Сначала выберите чат");
  if(!navigator.mediaDevices || !window.RTCPeerConnection) return alert("Звонки не поддерживаются этим браузером");
  if(!window.isSecureContext) return alert("Для звонков нужен HTTPS (или localhost).");
  try{
    callType=type;
    await loadRtcConfig();
    localCallStream=await navigator.mediaDevices.getUserMedia(type==="video"?{audio:true,video:true}:{audio:true});
    peer=createPeer(); pendingIceCandidates=[]; incomingIceCandidates=[]; callPeerUserId=Number(selected.id);
    clearTimeout(callTimeout); callTimeout=setTimeout(()=>{ if(peer && !["connected","completed"].includes(peer.iceConnectionState)) { endCall(true); alert("Не удалось установить соединение. Проверьте интернет или настройки TURN."); } },45000);
    localCallStream.getTracks().forEach(t=>peer.addTrack(t,localCallStream));
    $("callTitle").textContent=type==="video"?"📹 Видеозвонок":"📞 Аудиозвонок";
    $("callModal").style.display="grid";
    $("acceptCall").style.display="none";
    if(type==="video"){ $("remoteVideo").style.display="block"; $("remoteVideo").muted=true; $("localCallVideo").srcObject=localCallStream; $("localCallVideo").style.display="block"; }
    else { $("remoteVideo").style.display="none"; $("localCallVideo").style.display="none"; }
    callMicEnabled=true; callCameraEnabled=true; updateCallControls();
    const callId=`${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localCallId=callId;
    const offer=await peer.createOffer(); await peer.setLocalDescription(offer);
    callSocket({type:"call-signal",toUserId:Number(selected.id),signalType:"offer",callId,signal:{sdp:peer.localDescription.sdp,type:peer.localDescription.type},callType:type});
  }catch(e){ console.error(e); endCall(false); alert("Не удалось начать звонок. Разреши доступ к микрофону/камере."); }
}

let rtcConfig={iceServers:[
  {urls:"stun:stun.l.google.com:19302"},
  {urls:"stun:stun1.l.google.com:19302"}
]};
async function loadRtcConfig(){
  try{ const c=await api("/api/rtc-config"); if(Array.isArray(c.iceServers)&&c.iceServers.length) rtcConfig=c; }catch(_){}
}
function createPeer(){
  const pc=new RTCPeerConnection({
    ...rtcConfig,
    iceCandidatePoolSize: 10,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require"
  });
  pc.onicecandidate=e=>{
    if(e.candidate && callPeerUserId) {
      try { callSocket({type:"call-signal",toUserId:Number(callPeerUserId),signalType:"ice",callId:localCallId,signal:e.candidate}); }
      catch(_) {}
    }
  };
  pc.onicecandidateerror=e=>console.warn("ICE candidate error", e.errorCode, e.url);
  pc.oniceconnectionstatechange=()=>{
    if(["connected","completed"].includes(pc.iceConnectionState)) clearTimeout(callTimeout);
    if(pc.iceConnectionState==="failed") {
      console.warn("ICE failed; TURN may be unavailable");
    }
  };
  pc.ontrack=e=>{
    const stream=e.streams[0];
    $("remoteAudio").srcObject=stream;
    if(callType==="video"){$("remoteVideo").srcObject=stream;$("remoteVideo").muted=false;}
    $("remoteAudio").play().catch(()=>{});
    $("remoteVideo").play().catch(()=>{});
  };
  pc.onconnectionstatechange=()=>{
    if(["failed","disconnected","closed"].includes(pc.connectionState)) endCall(false);
  };
  return pc;
}

async function acceptIncomingCall(){
  if(!incomingCall)return;
  try{
    const from=incomingCall.fromUserId;
    callType=incomingCall.callType||"audio";
    selected={id:from,username:incomingCall.fromUsername};
    localCallStream=await navigator.mediaDevices.getUserMedia(
      callType==="video"?{audio:true,video:true}:{audio:true}
    );
    await loadRtcConfig();
    peer=createPeer();
    callPeerUserId=Number(from);
    clearTimeout(callTimeout); callTimeout=setTimeout(()=>{ if(peer && !["connected","completed"].includes(peer.iceConnectionState)) { endCall(true); alert("Не удалось установить соединение. Проверьте интернет или настройки TURN."); } },45000);
    localCallId=incomingCall.callId||null;
    localCallStream.getTracks().forEach(t=>peer.addTrack(t,localCallStream));
    await peer.setRemoteDescription(new RTCSessionDescription(incomingCall.signal));
    for(const c of (incomingCall.iceCandidates||[])){try{await peer.addIceCandidate(new RTCIceCandidate(c))}catch(e){}}
    for(const c of incomingIceCandidates){try{await peer.addIceCandidate(new RTCIceCandidate(c))}catch(e){}}
    incomingIceCandidates=[];
    const answer=await peer.createAnswer();
    await peer.setLocalDescription(answer);
    callSocket({type:"call-signal",toUserId:from,signalType:"answer",callId:localCallId,signal:{sdp:peer.localDescription.sdp,type:peer.localDescription.type},callType});
    incomingCall=null;
    $("acceptCall").style.display="none";
    $("callTitle").textContent=callType==="video"?"📹 Видеозвонок":"📞 Аудиозвонок";
    $("remoteVideo").style.display=callType==="video"?"block":"none";
    $("localCallVideo").srcObject=callType==="video"?localCallStream:null;
    $("localCallVideo").style.display=callType==="video"?"block":"none";
    callMicEnabled=true; callCameraEnabled=true; updateCallControls();
  }catch(e){
    console.error(e); endCall(false); alert("Не удалось принять звонок.");
  }
}

function showIncomingCallNotification(d){
  const title=d.callType==="video"?"📹 Входящий видеозвонок":"📞 Входящий аудиозвонок";
  const body=`@${d.fromUsername||"Пользователь"} звонит вам`;
  const toast=$("bktToast"); if(toast){ toast.innerHTML=`<b>${escapeHtml(title)}</b><span>${escapeHtml(body)}</span>`; toast.style.display="block"; clearTimeout(toastTimer); toastTimer=setTimeout(()=>toast.style.display="none",8000); }
  if("Notification" in window && Notification.permission==="granted") {
    try { const n=new Notification(title,{body,tag:"bkt-call-"+d.fromUserId,requireInteraction:true,icon:"/icon.svg",data:{call:true}}); n.onclick=()=>{window.focus(); n.close();}; } catch(e){}
  }
}

async function handleCallSignal(d){
  if(d.signalType==="call-created"){
    localCallId=d.callId||localCallId;
  }else if(d.signalType==="offer"){
    incomingCall=d;
    incomingIceCandidates=[];
    callType=d.callType||"audio";
    callPeerUserId=Number(d.fromUserId);
    localCallId=d.callId||null;
    $("callTitle").textContent=`Входящий ${callType==="video"?"видеозвонок":"аудиозвонок"} от @${d.fromUsername||""}`;
    $("acceptCall").style.display="block";
    $("remoteVideo").style.display=callType==="video"?"block":"none";
    $("localCallVideo").style.display="none";
    $("callModal").style.display="grid";
    showIncomingCallNotification(d);
  }else if(d.signalType==="ringing"){
    localCallId=d.callId||null;
  }else if(d.signalType==="answer" && peer){
    localCallId=d.callId||localCallId;
    await peer.setRemoteDescription(new RTCSessionDescription(d.signal));
    for(const c of incomingIceCandidates){try{await peer.addIceCandidate(new RTCIceCandidate(c));}catch(e){}}
    incomingIceCandidates=[];
  }else if(d.signalType==="ice"){
    if(peer && peer.remoteDescription && peer.remoteDescription.type){
      try{await peer.addIceCandidate(new RTCIceCandidate(d.signal));}catch(e){console.warn("ICE add failed",e)}
    }else{
      incomingIceCandidates.push(d.signal);
    }
  }else if(d.signalType==="unavailable"){
    alert("Пользователь сейчас не в сети или не подключён к звонкам.");
    endCall(false);
  }else if(d.signalType==="hangup"){
    endCall(false);
  }
}

function updateCallControls(){
  const mic=$("callMicButton"),cam=$("callCameraButton");
  if(mic){mic.textContent=callMicEnabled?"🎙️":"🔇";mic.classList.toggle("active",!callMicEnabled);mic.title=callMicEnabled?"Выключить микрофон":"Включить микрофон";}
  if(cam){cam.style.display=callType==="video"?"inline-grid":"none";cam.textContent=callCameraEnabled?"📹":"🚫";cam.classList.toggle("active",!callCameraEnabled);}
}
function toggleCallMic(){
  if(!localCallStream)return;
  callMicEnabled=!callMicEnabled;
  localCallStream.getAudioTracks().forEach(t=>t.enabled=callMicEnabled);
  updateCallControls();
}
function toggleCallCamera(){
  if(!localCallStream || callType!=="video")return;
  callCameraEnabled=!callCameraEnabled;
  localCallStream.getVideoTracks().forEach(t=>t.enabled=callCameraEnabled);
  updateCallControls();
}

function endCall(notify=true){
  clearTimeout(callTimeout); callTimeout=null;
  if(notify && callPeerUserId && socket && socket.readyState===WebSocket.OPEN)
    callSocket({type:"call-signal",toUserId:Number(callPeerUserId),signalType:"hangup",callId:localCallId,signal:{}});
  try{if(peer)peer.close()}catch(e){}
  if(localCallStream)localCallStream.getTracks().forEach(t=>t.stop());
  peer=null;localCallStream=null;incomingCall=null;pendingIceCandidates=[];incomingIceCandidates=[];callPeerUserId=null;localCallId=null;
  $("callModal").style.display="none";
  $("remoteVideo").srcObject=null;
  $("localCallVideo").srcObject=null;
  $("remoteAudio").srcObject=null;
  $("acceptCall").style.display="block";
}

$("audioCallButton").onclick=()=>startCall("audio");
$("videoCallButton").onclick=()=>startCall("video");
$("mediaPlusButton").onclick=()=>{ if(!selected||activeGroup){alert("Откройте личный чат");return;} $("mediaInput").click(); };
$("mediaInput").addEventListener("change",e=>{const f=e.target.files?.[0]; if(f)sendChatMedia(f); e.target.value="";});
window.addEventListener("visibilitychange",()=>{ if(peer && localCallStream){ /* keep call/mic alive while app is backgrounded */ } });




// Сессия восстанавливается один раз после загрузки DOM.

async function restoreSession(){
  const saved=sessionStorage.getItem("bkt_token");
  if(!saved) return;
  token=saved;
  await start();
}
document.addEventListener("DOMContentLoaded",restoreSession);


