const fs=require('node:fs');const file='自然地理生成器.html';let html=fs.readFileSync(file,'utf8');
const core=fs.readFileSync('src/volcano-core.js','utf8'),ui=fs.readFileSync('src/volcano-ui.js','utf8');
html=html.replace(/(<script id="volcano-src" type="text\/plain">)[\s\S]*?(<\/script>)/,(_,a,b)=>a+'\n'+core+'\n'+b);
html=html.replace(/\/\/ BEGIN VOLCANO UI[\s\S]*?\/\/ END VOLCANO UI/,()=> '// BEGIN VOLCANO UI\n'+ui+'\n// END VOLCANO UI');
fs.writeFileSync(file,html);
