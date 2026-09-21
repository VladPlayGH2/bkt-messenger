
(function(){
  function wire(id){
    const el=document.getElementById(id);
    if(!el || el.dataset.wired) return;
    el.dataset.wired="1";
    el.addEventListener("change",function(){
      if(!this.files || !this.files[0]) return;
      // Use the existing status preview logic when available.
      if(typeof window.previewStatusImage === "function"){
        const dt=new DataTransfer();
        dt.items.add(this.files[0]);
        const target=document.getElementById("statusPhotoInput");
        if(target && target!==this){
          try{ target.files=dt.files; }catch(e){}
        }
        window.previewStatusImage({target:this});
      } else {
        const img=document.querySelector(".phone-status-preview,#statusPreview");
        if(img) img.src=URL.createObjectURL(this.files[0]);
      }
    });
  }
  function init(){wire("statusPhotoInput");wire("statusCameraInput");}
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",init);
  else init();
  new MutationObserver(init).observe(document.body,{childList:true,subtree:true});
})();
