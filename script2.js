
document.addEventListener("click", function(e){
  const el=e.target.closest("[data-message-id]");
  if(!el) return;
  const id=el.getAttribute("data-message-id");
  if(window.handleEphemeralView) window.handleEphemeralView(id, el);
});
