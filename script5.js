
(function(){
  let waStatuses=[], waCurrentIndex=0, waTimer=null, cameraStream=null, cameraShot=null;

  const $=id=>document.getElementById(id);
  const esc=v=>typeof escapeHtml==="function"?escapeHtml(v||""):String(v||"");
  const authHeaders=()=>typeof token!=="undefined"&&token?{Authorization:"Bearer "+token}:{};

  window.openStatuses=async function(){
    const modal=$("statusesModal"); if(modal) modal.style.display="flex";
    await loadStatuses();
  };
  window.closeStatuses=function(){
    const modal=$("statusesModal"); if(modal) modal.style.display="none";
  };
  window.focusStatusComposer=function(){
    const m=$("statusComposerModal"); if(m) m.style.display="flex";
    const old=$("statusesModal"); if(old) old.style.display="none";
  };
  window.closeStatusComposer=function(){
    stopStatusCamera();
    const m=$("statusComposerModal"); if(m) m.style.display="none";
  };

  function statusAvatar(s){return s.avatar||s.avatar_url||"";}
  function renderStatusRow(s,i){
    const row=document.createElement("div");
    row.className="wa-status-row";
    row.onclick=()=>openStatusViewer(i);
    const av=document.createElement("div");
    av.className="wa-status-avatar";
    const src=statusAvatar(s);
    if(src) av.style.backgroundImage=`url("${src}")`;
    const body=document.createElement("div");
    body.className="wa-status-row-body";
    body.innerHTML=`<div class="wa-status-row-name">${esc(s.username||"Пользователь")}</div>
      <div class="wa-status-row-time">${s.created_at?new Date(s.created_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}):"Недавно"}</div>`;
    row.append(av,body);
    return row;
  }

  window.loadStatuses=async function(){
    const list=$("statusFeed"), empty=$("statusEmpty"); if(!list)return;
    list.innerHTML="";
    try{
      const r=await fetch("/api/statuses",{headers:authHeaders()});
      const data=await r.json();
      if(!r.ok) throw new Error(data.error||"Не удалось загрузить статусы");
      waStatuses=Array.isArray(data)?data:[];
      if(empty){empty.style.display=waStatuses.length?"none":"block";empty.textContent="Здесь появятся статусы контактов";}
      waStatuses.forEach((s,i)=>list.appendChild(renderStatusRow(s,i)));
      const my=$("waMyStatusAvatar");
      if(my && typeof me!=="undefined" && me && (me.avatar||me.avatar_url))
        my.style.backgroundImage=`url("${me.avatar||me.avatar_url}")`;
    }catch(e){
      if(empty){empty.style.display="block";empty.textContent=e.message||"Не удалось загрузить статусы";}
    }
  };

  window.openStatusViewer=function(i){
    if(!waStatuses[i])return;
    waCurrentIndex=i;
    const m=$("statusViewerModal"); if(m)m.style.display="flex";
    showStatus(i);
  };
  window.closeStatusViewer=function(){
    clearTimeout(waTimer);
    const m=$("statusViewerModal"); if(m)m.style.display="none";
  };
  function showStatus(i){
    const s=waStatuses[i]; if(!s)return;
    const media=$("waViewerMedia"),cap=$("waViewerCaption"),author=$("waViewerAuthor"),prog=$("waViewerProgress");
    media.innerHTML="";
    if(s.media_url){
      const img=document.createElement("img"); img.src=s.media_url; img.alt=""; media.appendChild(img);
    }else{
      const box=document.createElement("div");
      box.style.cssText="color:#fff;font-size:26px;padding:30px;text-align:center";
      box.textContent=s.text||""; media.appendChild(box);
    }
    author.textContent=s.username||"Пользователь";
    cap.textContent=s.text||"";
    if(prog){prog.innerHTML="";void prog.offsetWidth;prog.className="wa-viewer-progress";}
    clearTimeout(waTimer);
    waTimer=setTimeout(()=>{if(waCurrentIndex<waStatuses.length-1){waCurrentIndex++;showStatus(waCurrentIndex)}else closeStatusViewer()},5000);
  }

  let sx=0;
  document.addEventListener("touchstart",e=>{
    if($("statusViewerModal")?.style.display!=="flex")return;
    sx=e.touches[0].clientX;
  },{passive:true});
  document.addEventListener("touchend",e=>{
    if($("statusViewerModal")?.style.display!=="flex")return;
    const dx=e.changedTouches[0].clientX-sx;
    if(Math.abs(dx)>60){
      if(dx<0&&waCurrentIndex<waStatuses.length-1){waCurrentIndex++;showStatus(waCurrentIndex)}
      if(dx>0&&waCurrentIndex>0){waCurrentIndex--;showStatus(waCurrentIndex)}
    }
  },{passive:true});

  function previewFile(file){
    if(!file)return;
    const wrap=$("statusPreviewWrap"),img=$("statusPreview");
    if(wrap&&img){img.src=URL.createObjectURL(file);wrap.style.display="block";}
  }
  function wireInput(id){
    const el=$(id); if(!el||el.dataset.waWired)return;
    el.dataset.waWired="1";
    el.addEventListener("change",()=>previewFile(el.files&&el.files[0]));
  }
  wireInput("statusPhotoInput"); wireInput("statusCameraInput");

  window.previewStatusImage=function(ev){const f=ev?.target?.files?.[0];if(f)previewFile(f);};

  window.startStatusCamera=async function(){
    const box=$("statusCameraBox"),video=$("statusCameraVideo");
    if(!box||!video)return;
    try{
      cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});
      video.srcObject=cameraStream; box.classList.add("active");
    }catch(e){
      // On phones that block getUserMedia, open the native camera picker.
      const input=$("statusCameraInput"); if(input) input.click();
    }
  };
  window.stopStatusCamera=function(){
    if(cameraStream){cameraStream.getTracks().forEach(t=>t.stop());cameraStream=null;}
    const v=$("statusCameraVideo"); if(v)v.srcObject=null;
    const box=$("statusCameraBox"); if(box)box.classList.remove("active");
  };
  window.takeStatusPhoto=function(){
    const video=$("statusCameraVideo"); if(!video||!video.videoWidth)return;
    const canvas=document.createElement("canvas");
    canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    canvas.getContext("2d").drawImage(video,0,0);
    canvas.toBlob(blob=>{
      if(!blob)return;
      cameraShot=new File([blob],"camera-status.jpg",{type:"image/jpeg"});
      previewFile(cameraShot);
      stopStatusCamera();
    },"image/jpeg",0.9);
  };

  window.publishStatus=async function(){
    const photo=$("statusPhotoInput"),camera=$("statusCameraInput"),cap=$("statusCaption");
    const file=cameraShot || photo?.files?.[0] || camera?.files?.[0];
    if(!file){alert("Выберите фото или сделайте снимок.");return;}
    const btn=$("statusPublishButton");
    if(btn){btn.disabled=true;btn.textContent="Публикация…";}
    try{
      const fd=new FormData();
      // IMPORTANT: server expects the field name "image".
      fd.append("image",file,file.name||"status.jpg");
      const upload=await fetch("/api/statuses/upload",{method:"POST",headers:authHeaders(),body:fd});
      const up=await upload.json().catch(()=>({}));
      if(!upload.ok)throw new Error(up.error||"Не удалось загрузить фото");
      const mediaUrl=up.url||up.mediaUrl;
      if(!mediaUrl)throw new Error("Сервер не вернул ссылку на фото");
      const saved=await fetch("/api/statuses",{
        method:"POST",
        headers:{"Content-Type":"application/json",...authHeaders()},
        body:JSON.stringify({text:(cap?.value||"").trim(),mediaUrl})
      });
      const data=await saved.json().catch(()=>({}));
      if(!saved.ok)throw new Error(data.error||"Не удалось сохранить статус");
      cameraShot=null;
      if(cap)cap.value="";
      if(photo)photo.value="";
      if(camera)camera.value="";
      if($("statusPreviewWrap"))$("statusPreviewWrap").style.display="none";
      closeStatusComposer();
      await openStatuses();
    }catch(e){alert(e.message||"Не удалось опубликовать статус.");}
    finally{if(btn){btn.disabled=false;btn.textContent="Опубликовать";}}
  };
})();
