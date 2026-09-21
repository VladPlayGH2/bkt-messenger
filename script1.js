
(function(){
  let ephemeralMode = "off";
  const picker = document.getElementById("ephemeralPicker");
  if(!picker) return;
  picker.addEventListener("click", e=>{
    const b=e.target.closest("[data-ephemeral]");
    if(!b) return;
    ephemeralMode=b.dataset.ephemeral;
    picker.querySelectorAll("button").forEach(x=>x.classList.toggle("active",x===b));
  });
  window.getEphemeralMode = ()=>ephemeralMode;
  window.markEphemeralMessage = async function(id){
    if(!id || ephemeralMode==="off") return;
    try{
      await fetch("/api/messages/disappear",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({id,mode:ephemeralMode})
      });
    }catch(e){}
  };
  window.handleEphemeralView = async function(id, el){
    if(!id) return;
    try{
      const r=await fetch("/api/messages/"+encodeURIComponent(id)+"/view",{method:"POST"});
      const data=await r.json();
      if(data.expired && el) el.remove();
    }catch(e){}
  };
})();
