// Rakenda salvestatud teemaeelistus enne CSS-i renderdamist, et vältida valge/tumeda vilkumist.
(function(){
  try{
    var t = localStorage.getItem("theme-preference");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  }catch(e){}
})();
