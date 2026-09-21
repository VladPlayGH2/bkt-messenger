
(function(){
  const translations = {
    ru:{
      settings:"Настройки",notifications:"Уведомления",group:"Группа",chooseChat:"Выберите чат",
      profileSettings:"Настройки профиля",login:"Логин",about:"О себе",avatar:"Аватар",
      chooseSticker:"Выберите другой стикер для аватарки.",chatWallpaper:"Обои чата",
      language:"Язык",apply:"Применить",reset:"Сбросить",save:"Сохранить",cancel:"Отмена",logout:"Выйти",
      wallpaperUrl:"Ссылка на обои",secretCode:"Секретный код"
    },
    en:{
      settings:"Settings",notifications:"Notifications",group:"Group",chooseChat:"Choose a chat",
      profileSettings:"Profile settings",login:"Username",about:"About",avatar:"Avatar",
      chooseSticker:"Choose another sticker for your avatar.",chatWallpaper:"Chat wallpaper",
      language:"Language",apply:"Apply",reset:"Reset",save:"Save",cancel:"Cancel",logout:"Log out",
      wallpaperUrl:"Wallpaper URL",secretCode:"Secret code"
    },
    zh:{
      settings:"设置",notifications:"通知",group:"群组",chooseChat:"选择聊天",
      profileSettings:"个人资料设置",login:"用户名",about:"关于我",avatar:"头像",
      chooseSticker:"为头像选择另一个贴纸。",chatWallpaper:"聊天壁纸",
      language:"语言",apply:"应用",reset:"重置",save:"保存",cancel:"取消",logout:"退出",
      wallpaperUrl:"壁纸链接",secretCode:"安全代码"
    },
    es:{
      settings:"Ajustes",notifications:"Notificaciones",group:"Grupo",chooseChat:"Elige un chat",
      profileSettings:"Ajustes del perfil",login:"Usuario",about:"Sobre mí",avatar:"Avatar",
      chooseSticker:"Elige otro sticker para tu avatar.",chatWallpaper:"Fondo del chat",
      language:"Idioma",apply:"Aplicar",reset:"Restablecer",save:"Guardar",cancel:"Cancelar",logout:"Salir",
      wallpaperUrl:"Enlace del fondo",secretCode:"Código secreto"
    }
  };

  window.applyLanguage = function(lang){
    lang = translations[lang] ? lang : "ru";
    document.documentElement.lang = lang === "zh" ? "zh-CN" : lang;
    const t=translations[lang];
    document.querySelectorAll("[data-i18n]").forEach(el=>{
      const key=el.getAttribute("data-i18n");
      if(t[key]) el.textContent=t[key];
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(el=>{
      const key=el.getAttribute("data-i18n-placeholder");
      if(t[key]) el.placeholder=t[key];
    });
    const select=document.getElementById("languageSelect");
    if(select) select.value=lang;
    localStorage.setItem("bkt_language",lang);
  };

  window.changeLanguage = function(lang){
    applyLanguage(lang);
  };

  const saved=localStorage.getItem("bkt_language") || "ru";
  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",()=>applyLanguage(saved),{once:true});
  }else{
    applyLanguage(saved);
  }
})();
