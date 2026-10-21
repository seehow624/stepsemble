/* A conversation's summary: its goals, the subagents it ran, what it made for
   the person and what it read, gathered from what the page already holds. A
   small card in the corner that only its icon opens and closes; on a phone a
   tap anywhere else closes it too. */
(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.StepsembleSessionSummary=api;})(typeof window!=="undefined"?window:globalThis,function(){
  "use strict";
  const MAX_ROWS=50,STORE="stepsemble.summary.sections.v1";
  const plain=value=>!!value&&typeof value==="object"&&!Array.isArray(value);
  // Tools that write a file, and tools that make a picture, clip or sound, by
  // the names agents give them.
  const WRITES=new Set(["write","edit","multiedit","multi_edit","notebookedit","notebook_edit","apply_patch","create_file","write_file","edit_file","str_replace_editor","str_replace_based_edit_tool"]);
  const MAKES=new Set(["image_generation","generate_image","imagegen","create_image","edit_image","text_to_image","generate_video","text_to_video","image_to_video","generate_audio","generate_speech","text_to_speech","generate_music"]);
  const FETCHES=new Set(["webfetch","web_fetch","fetch","fetch_url","browse"]);
  const SEARCHES=new Set(["websearch","web_search","search","google_search"]);
  // What a file is, by its type or extension. Code, config and text are what
  // Changes shows, so none of them is an output. .key and .obj are left out:
  // they are as often a private key or a compiled object as Keynote or a mesh.
  const KINDS={image:"png jpg jpeg gif webp avif heic heif bmp tif tiff ico icns svg dng",video:"mp4 m4v mov webm mkv avi wmv flv mpg mpeg 3gp ogv",
    audio:"mp3 wav m4a aac flac ogg oga opus aif aiff caf mid midi",pdf:"pdf",document:"doc docx odt rtf pages epub",sheet:"xls xlsx ods numbers",slides:"ppt pptx odp",
    archive:"zip tar gz tgz bz2 xz 7z rar zst",package:"dmg pkg apk aab ipa msi exe deb rpm appimage vsix xpi",design:"psd ai sketch fig xd",model:"glb gltf stl fbx usdz 3mf blend"};
  const EXTENSIONS=new Map(Object.entries(KINDS).flatMap(([kind,list])=>list.split(" ").map(ext=>[ext,kind])));
  const MIMES=[[/^image\//,"image"],[/^video\//,"video"],[/^audio\//,"audio"],[/^application\/pdf$/,"pdf"],[/^application\/(?:zip|gzip|x-(?:tar|gzip|bzip2|xz|7z-compressed|rar-compressed))$/,"archive"],
    [/wordprocessingml|^application\/(?:msword|rtf|epub\+zip|vnd\.oasis\.opendocument\.text)$/,"document"],[/spreadsheetml|^application\/vnd\.(?:ms-excel|oasis\.opendocument\.spreadsheet)$/,"sheet"],
    [/presentationml|^application\/vnd\.(?:ms-powerpoint|oasis\.opendocument\.presentation)$/,"slides"]];
  const fileName=path=>String(path||"").replace(/:\d+(?::\d+)?$/,"").split(/[\\/]/).filter(Boolean).pop()||"";
  const extension=path=>{const name=fileName(path),dot=name.lastIndexOf(".");return dot>0?name.slice(dot+1).toLowerCase():"";};
  function fileKind(path,mime){
    const type=String(mime||"").toLowerCase().split(";")[0].trim();
    for(const [pattern,kind] of MIMES)if(type&&pattern.test(type))return kind;
    return EXTENSIONS.get(extension(path))||"";
  }
  const absolute=value=>/^(?:\/|~\/|[A-Za-z]:[\\/])/.test(value);
  const parse=value=>{try{return new URL(String(value||"").trim());}catch{return null;}};
  const web=value=>{const url=parse(value);return url&&["http:","https:"].includes(url.protocol)?url:null;};
  // This computer, the home network or a tailnet: an app or site the agent started.
  const LOCAL=/^(?:localhost|0\.0\.0\.0|\[::1?\]|\[fe80:[^\]]*\])$|\.(?:localhost|local|lan|internal|home\.arpa|ts\.net)$/;
  const privateAddress=host=>{const m=/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);if(!m)return false;const a=+m[1],b=+m[2];
    return a===127||a===10||a===192&&b===168||a===172&&b>=16&&b<=31||a===169&&b===254||a===100&&b>=64&&b<=127;};
  // Hosted previews of a site or an app.
  const PREVIEWS=/\.(?:vercel\.app|netlify\.app|pages\.dev|workers\.dev|trycloudflare\.com|ngrok\.io|ngrok\.app|ngrok-free\.app|ngrok-free\.dev|loca\.lt|onrender\.com|fly\.dev|herokuapp\.com|up\.railway\.app|surge\.sh|glitch\.me|replit\.dev|repl\.co|web\.app|firebaseapp\.com|deno\.dev|csb\.app|vusercontent\.net|lovable\.app)$/;
  // Where a file, a build or a change is handed over, and which of their pages
  // are that rather than something to read.
  const SHARES=[[/^drive\.google\.com$/,/^\/(?:file|drive\/folders|open)\b/],[/^docs\.google\.com$/,/^\/(?:document|spreadsheets|presentation|forms|drawings)\//],
    [/^(?:www\.)?dropbox\.com$/,/^\/(?:s|sh|scl|t)\//],[/^dl\.dropboxusercontent\.com$/],[/^1drv\.ms$/],[/^onedrive\.live\.com$/],[/\.sharepoint\.com$/],
    [/^(?:www\.)?icloud\.com$/,/^\/(?:iclouddrive|photos|pages|numbers|keynote|freeform|sharedalbum)\b/],[/^(?:app\.)?box\.com$/,/^\/s\//],[/^(?:www\.)?wetransfer\.com$|^we\.tl$/],
    [/^gist\.github\.com$/],[/^github\.com$/,/^\/[^/]+\/[^/]+\/(?:pull\/\d+|releases\/(?:tag|download)\/|actions\/runs\/\d+)/],[/^gitlab\.com$/,/\/-\/(?:merge_requests\/\d+|releases\/)/],
    [/^(?:www\.)?figma\.com$/,/^\/(?:file|design|proto|board|slides)\//],[/^(?:www\.)?loom\.com$/,/^\/share\//],[/^testflight\.apple\.com$/,/^\/join\//],[/^(?:www\.)?notion\.so$/],
    [/^(?:i\.)?imgur\.com$/],[/^codesandbox\.io$/,/^\/(?:s|p)\//],[/^stackblitz\.com$/,/^\/edit\//],[/^(?:www\.)?canva\.com$/,/^\/design\//],[/\.r2\.dev$/]];
  const SIGNED=/[?&]x-(?:amz|goog)-signature=/i;
  // Schemes that carry data or reach a server rather than open an app.
  const NOT_OPENED=/^(?:javascript|data|vbscript|blob|about|file|mailto|tel|sms|cid|ws|wss|ssh|git|svn|sftp|ftps?|s3|gs|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mqtt|kafka|nats|jdbc|ldaps?|smtp|imap|pop3|tcp|udp|grpc|unix|docker|oci|npm|chrome|edge|view-source|urn|xmpp|magnet|webcal)$/;
  // "preview" (an app or site to look at), "share" (something handed over),
  // "app" (a deep link) or "" (a page: a citation).
  function linkKind(value){
    const url=parse(value);if(!url)return "";
    const scheme=url.protocol.slice(0,-1).toLowerCase();
    if(scheme!=="http"&&scheme!=="https")return String(value).includes("://")&&!NOT_OPENED.test(scheme)?"app":"";
    const host=url.hostname.toLowerCase();
    if(LOCAL.test(host)||privateAddress(host)||PREVIEWS.test(host))return "preview";
    return SIGNED.test(url.search)||SHARES.some(([hosts,paths])=>hosts.test(host)&&(!paths||paths.test(url.pathname)))?"share":"";
  }
  function shortPath(url){
    const parts=url.pathname.split("/").filter(Boolean).map(part=>{let text=part;try{text=decodeURIComponent(part);}catch{}return text.length>20?text.slice(0,8)+"…":text;});
    const route=url.hash.startsWith("#/")?url.hash:"";
    return (parts.length?"/"+parts.join("/"):route?"/":"")+route;
  }
  function linkRow(url,kind){
    const page=["http:","https:"].includes(url.protocol);
    return {type:"link",kind,url:url.href,host:page?url.host.replace(/^www\./,""):url.protocol+"//"+url.host,path:shortPath(url).slice(0,120)};
  }
  function fileRow(value,mime){
    const path=String(value||"").trim(),kind=path&&path!=="files"&&path.length<=4096?fileKind(path,mime):"";
    if(!kind)return null;
    return {type:"file",kind,path,name:fileName(path),ext:extension(path).toUpperCase(),folder:/[\\/]/.test(path)?fileName(path.replace(/[\\/][^\\/]*$/,"")):"",openable:absolute(path)};
  }
  // Newest first, each once.
  function newestFirst(rows,key){const seen=new Map();for(const row of rows){const id=key(row);seen.delete(id);seen.set(id,row);}return [...seen.values()].reverse().slice(0,MAX_ROWS);}
  // items, in the order the conversation shows them: {tool:{name,args}}, {link}
  // (a link in a reply), {mention} (an address a reply shows on its own, as
  // code) or {file} (a path on the Host a reply links, shows or names).
  // Outputs are files that are not code and links to open; Sources are pages
  // fetched and searches run, and the links in replies that cite a page.
  function summarize(items){
    const list=(Array.isArray(items)?items:[]).filter(plain),made=[],read=[],fetched=new Set();
    for(const item of list){const name=String(item.tool?.name||"").toLowerCase(),url=FETCHES.has(name)?web(item.tool?.args?.url):null;if(url)fetched.add(url.href);}
    for(const item of list){
      if(plain(item.tool)){
        const name=String(item.tool.name||"").toLowerCase(),args=plain(item.tool.args)?item.tool.args:{};
        if(WRITES.has(name)||MAKES.has(name)){
          const mime=args.mime_type||args.mimeType||"";
          for(const path of [args.file_path,args.filePath,args.notebook_path,args.path,args.output_path,args.outputPath,...(Array.isArray(args.changes)?args.changes.map(change=>change?.path):[])]){
            const row=typeof path==="string"?fileRow(path,mime):null;if(row)made.push(row);
          }
          continue;
        }
        const url=FETCHES.has(name)?web(args.url):null;
        if(url)read.push(linkRow(url,"page"));
        else if(SEARCHES.has(name)&&typeof args.query==="string"&&args.query.trim())read.push({type:"search",query:args.query.trim().slice(0,200)});
        continue;
      }
      if(typeof item.file==="string"){const row=fileRow(item.file);if(row)made.push(row);continue;}
      const value=typeof item.link==="string"?item.link:typeof item.mention==="string"?item.mention:"";
      const url=parse(value);if(!url)continue;
      // A shared document the agent read first is something it cites.
      const kind=linkKind(value);
      if(kind&&!(kind==="share"&&fetched.has(url.href)))made.push(linkRow(url,kind));
      else if(typeof item.link==="string"&&web(value))read.push(linkRow(url,"page"));
    }
    const outputs=newestFirst(made,row=>row.type==="file"?"f:"+row.path:"u:"+row.url),handed=new Set(outputs.map(row=>row.url).filter(Boolean));
    return {outputs,sources:newestFirst(read.filter(row=>!handed.has(row.url)),row=>row.url||"?"+row.query)};
  }
  // Which sections are open. Outputs start open, the rest while they are
  // short; what the person chose is kept.
  function sectionStates(storage){try{const value=JSON.parse(storage?.getItem?.(STORE)||"{}");return plain(value)?value:{};}catch{return {};}}
  function sectionOpen(storage,name,count){const value=sectionStates(storage)[name];return typeof value==="boolean"?value:name==="outputs"||count<=3;}
  function rememberSection(storage,name,open){const states=sectionStates(storage);states[name]=!!open;try{storage?.setItem?.(STORE,JSON.stringify(states));}catch{}}
  // Line icons on the app's 24-unit grid.
  const ICONS={image:"M5 4.5h14A1.5 1.5 0 0 1 20.5 6v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5zM3.5 15.5l4.5-4.5 4 4 3-3 5 5M15.5 9h.01",
    video:"M4.5 6h10A1.5 1.5 0 0 1 16 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 3 16.5v-9A1.5 1.5 0 0 1 4.5 6zM16 10.5l5-3v9l-5-3",
    audio:"M9 17.5V5.5l10.5-2v12M9 17.5a2.75 2.75 0 1 1-2.75-2.75A2.75 2.75 0 0 1 9 17.5zM19.5 15.5a2.75 2.75 0 1 1-2.75-2.75 2.75 2.75 0 0 1 2.75 2.75z",
    file:"M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8zM14 3.5V8h4.5M9 13h6M9 16.5h4",
    sheet:"M5 4.5h14A1.5 1.5 0 0 1 20.5 6v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5zM3.5 9.5h17M3.5 14.5h17M9.5 9.5v10",
    slides:"M3.5 4.5h17M5 4.5v10A1.5 1.5 0 0 0 6.5 16h11a1.5 1.5 0 0 0 1.5-1.5v-10M12 16v4.5M8.5 20.5h7",
    archive:"M4 4.5h16v4H4zM5.5 8.5V19A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5M10 12.5h4",
    package:"M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",design:"M15.5 4.5l4 4L9 19l-5 1 1-5zM13 7l4 4",model:"M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",
    preview:"M4.5 4.5h15A1.5 1.5 0 0 1 21 6v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15V6a1.5 1.5 0 0 1 1.5-1.5zM8.5 20.5h7M12 16.5v4",
    share:"M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
    app:"M14 4h6v6M20 4l-8.5 8.5M17.5 14v4.5A1.5 1.5 0 0 1 16 20H5.5A1.5 1.5 0 0 1 4 18.5V8a1.5 1.5 0 0 1 1.5-1.5H10",
    page:"M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.4 2.5 3.5 5.3 3.5 8.5s-1.1 6-3.5 8.5c-2.4-2.5-3.5-5.3-3.5-8.5s1.1-6 3.5-8.5z",
    search:"M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.75-4.75",chevron:"M6 9l6 6 6-6"};
  const ICON_OF={pdf:"file",document:"file"};
  function mount({document,container,t,storage=null,phone=()=>false,anchor=()=>null,below=()=>[],watch=null,thumb=async()=>"",onToggle=()=>{},onSubagent=()=>{},onFile=()=>{},onChanges=()=>{},fileLink}){
    const el=(tag,cls="",text="")=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;};
    const icon=name=>{const svg=document.createElementNS("http://www.w3.org/2000/svg","svg"),path=document.createElementNS("http://www.w3.org/2000/svg","path");
      svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("aria-hidden","true");svg.setAttribute("class","session-summary-icon");path.setAttribute("d",ICONS[name]||ICONS.file);svg.append(path);return svg;};
    const panel=el("section","session-summary");panel.id="session-summary";panel.hidden=true;panel.setAttribute("role","region");panel.dataset.i18nIgnore="";
    // On a phone a tap outside lands here: it closes the summary and nothing
    // under it is pressed.
    const scrim=el("div","session-summary-scrim");scrim.hidden=true;scrim.setAttribute("aria-hidden","true");
    container.append(scrim,panel);
    const view=document.defaultView||globalThis,thumbs=new Map();
    let collect=null,signature="",leaving=0,later=0,release=0,observer=null,sizes=null;
    const open=()=>!panel.hidden&&panel.dataset.leaving===undefined;
    const still=()=>document.documentElement.classList.contains("reduced-motion")||!!view.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const text=(primary,meta)=>{const box=el("span","session-summary-text");box.append(el("span","session-summary-name",primary));if(meta)box.append(el("span","session-summary-meta",meta));return box;};
    const lead=kind=>{const box=el("span","session-summary-lead");box.dataset.kind=kind;box.append(icon(ICON_OF[kind]||kind));return box;};
    function section(name,rows){
      if(!rows.length)return null;
      const expanded=sectionOpen(storage,name,rows.length),box=el("section","session-summary-section"),heading=el("h3","session-summary-heading"),list=el("ul","session-summary-list");
      const toggle=el("button","session-summary-toggle");toggle.type="button";toggle.dataset.key="section:"+name;toggle.setAttribute("aria-expanded",String(expanded));toggle.setAttribute("aria-controls","session-summary-"+name);
      toggle.append(el("span","session-summary-title",t(name)),el("span","session-summary-count",String(rows.length)),icon("chevron"));
      toggle.addEventListener("click",()=>{const next=toggle.getAttribute("aria-expanded")!=="true";rememberSection(storage,name,next);toggle.setAttribute("aria-expanded",String(next));list.hidden=!next;});
      box.dataset.section=name;list.id="session-summary-"+name;list.hidden=!expanded;
      for(const row of rows){const li=el("li");li.append(row);list.append(li);}
      heading.append(toggle);box.append(heading,list);return box;
    }
    function picture(box,path){
      let request=thumbs.get(path);
      if(!request){request=Promise.resolve().then(()=>thumb(path)).catch(()=>"");thumbs.set(path,request);request.then(src=>{if(!src)setTimeout(()=>{if(thumbs.get(path)===request)thumbs.delete(path);},30000);});}
      request.then(src=>{
        if(!src||!box.isConnected)return;
        const img=el("img");img.alt="";img.decoding="async";img.src=src;
        img.addEventListener("error",()=>{if(thumbs.get(path)===request)thumbs.delete(path);box.replaceChildren(icon("image"));box.classList.remove("has-thumb");},{once:true});
        box.replaceChildren(img);box.classList.add("has-thumb");
      });
    }
    function fileItem(row){
      const meta=row.folder,front=lead(row.kind);
      if(!row.openable){const item=el("span","session-summary-row session-summary-file");item.title=row.path;item.append(front,text(row.name,meta));return item;}
      const link=fileLink(row.path,row.name);link.textContent="";link.classList.add("session-summary-row","session-summary-file");link.dataset.key="file:"+row.path;link.append(front,text(row.name,meta));
      if(row.kind==="image")picture(front,row.path);
      link.addEventListener("click",event=>{event.preventDefault();onFile(link);});
      link.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onFile(link);}});
      return link;
    }
    function linkItem(row){
      const link=el("a","session-summary-row session-summary-link");link.href=row.url;link.title=row.url;link.dataset.key="url:"+row.url;
      if(row.kind!=="app"){link.target="_blank";link.rel="noopener noreferrer";}
      link.append(lead(row.kind),text(row.host,row.path));return link;
    }
    function render(){
      if(!open()||!collect)return;
      const data=collect(),next=JSON.stringify(data);
      if(next===signature)return place();
      signature=next;
      const focused=panel.contains(document.activeElement)?document.activeElement.dataset?.key:"",scroll=panel.scrollTop;
      const goals=(data.goals||[]).map(goal=>{const row=el("div","session-summary-goal");row.dataset.state=goal.state||"";
        row.append(el("span","session-summary-goal-objective",goal.objective),el("span","session-summary-meta",[goal.label,goal.elapsed].filter(Boolean).join(" · ")));return row;});
      const subagents=(data.subagents||[]).map(row=>{const item=el("button","session-summary-row session-summary-item");item.type="button";item.dataset.state=row.status||"";item.dataset.key="subagent:"+row.id;
        item.append(text(row.name||"subagent",[row.statusLabel,row.task].filter(Boolean).join(" · ")));
        item.addEventListener("click",()=>{hide({restore:false});onSubagent(row.id);});return item;});
      const outputs=(data.outputs||[]).map(row=>row.type==="file"?fileItem(row):linkItem(row));
      const sources=(data.sources||[]).map(row=>{if(row.type!=="search")return linkItem(row);
        const item=el("span","session-summary-row session-summary-query");item.title=row.query;item.append(lead("search"),text(row.query));return item;});
      const parts=[section("goals",goals),section("subagents",subagents),section("outputs",outputs),section("sources",sources)].filter(Boolean);
      if(!parts.length)parts.push(el("p","session-summary-none",t("empty")));
      // Code is in Changes.
      if(data.changes){const changes=el("button","session-summary-changes",`${t("viewChanges")} · ${data.changes}`);changes.type="button";changes.dataset.key="changes";
        changes.addEventListener("click",()=>{hide({restore:false});onChanges();});parts.push(changes);}
      panel.replaceChildren(...parts);panel.setAttribute("aria-label",t("title"));panel.scrollTop=scroll;
      if(focused)[...panel.querySelectorAll("[data-key]")].find(node=>node.dataset.key===focused)?.focus({preventScroll:true});
      place();
    }
    // Under its icon on a phone, in the pane's corner on a desktop, and never
    // over the message box.
    function place(){
      if(panel.hidden)return;
      // A window narrowed to a phone's width while it is open takes the phone's way of closing.
      if(open())scrim.hidden=!phone();
      const box=container.getBoundingClientRect(),spot=phone()?anchor()?.getBoundingClientRect?.():null;
      let top=8;
      if(spot&&spot.height){top=Math.round(spot.bottom-box.top+6);const right=Math.max(8,Math.round(box.right-spot.right-4));panel.style.top=top+"px";panel.style.right=right+"px";
        panel.style.transformOrigin=`${Math.round(panel.offsetWidth-(box.right-right-(spot.left+spot.width/2)))}px 0`;}
      else{panel.style.top=panel.style.right=panel.style.transformOrigin="";top=panel.offsetTop||top;}
      const floor=Math.min(...(below()||[]).map(node=>node?.getBoundingClientRect?.()).filter(rect=>rect&&rect.height).map(rect=>rect.top));
      if(Number.isFinite(floor))panel.style.setProperty("--session-summary-room",Math.max(132,Math.round(floor-box.top-top-12))+"px");else panel.style.removeProperty("--session-summary-room");
    }
    function follow(on){
      observer?.disconnect();sizes?.disconnect();observer=sizes=null;clearTimeout(later);later=0;view.removeEventListener?.("resize",place);
      if(!on)return;
      // While the agent works the summary keeps up, a few times a second at most.
      if(watch&&typeof view.MutationObserver==="function"){observer=new view.MutationObserver(()=>{if(!later)later=setTimeout(()=>{later=0;render();},500);});observer.observe(watch,{childList:true,subtree:true});}
      if(typeof view.ResizeObserver==="function"){sizes=new view.ResizeObserver(()=>place());sizes.observe(container);for(const node of below()||[])if(node)sizes.observe(node);}
      view.addEventListener?.("resize",place);
    }
    function show(source,{focus=false}={}){
      clearTimeout(leaving);clearTimeout(release);
      const opening=!open();collect=source;signature="";delete panel.dataset.leaving;panel.hidden=false;scrim.hidden=!phone();
      render();
      if(opening){follow(true);onToggle(true,{});}
      if(focus)panel.querySelector("button, a, [tabindex]")?.focus({preventScroll:true});
    }
    function hide({restore,tap=false}={}){
      if(!open())return;
      // Focus inside goes back to the icon, unless the summary led elsewhere.
      const back=restore??panel.contains(document.activeElement);
      follow(false);clearTimeout(leaving);
      const done=()=>{panel.hidden=true;delete panel.dataset.leaving;};
      if(still())done();else{panel.dataset.leaving="";leaving=setTimeout(done,140);}
      // The tap that closed it keeps the layer until its click has landed here.
      clearTimeout(release);if(tap)release=setTimeout(()=>{scrim.hidden=true;},450);else scrim.hidden=true;
      onToggle(false,{restore:back});
    }
    function toggle(source,options){if(open())hide(options);else show(source,options);}
    scrim.addEventListener("pointerdown",event=>{event.preventDefault();hide({tap:true});});
    scrim.addEventListener("click",event=>{event.preventDefault();event.stopPropagation();clearTimeout(release);if(!open())scrim.hidden=true;});
    panel.addEventListener("keydown",event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();hide({restore:true});}});
    return {show,hide,toggle,render,isOpen:open,element:panel};
  }
  return {summarize,fileKind,linkKind,sectionOpen,rememberSection,mount};
});
