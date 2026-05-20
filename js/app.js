// ============================================================
// MANDELLI & CARVALHO — Plataforma de Arquivos
// ============================================================

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
].join(" ");

const DISCOVERY_DOC = "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest";
const CIDADES = ["Maringá", "Porto Rico"];

let gapiInited = false;
let gisInited = false;
let tokenClient = null;
let accessToken = null;
let usuarioAtual = null;
let obraAtiva = null;
let pastaRaizId = null;
let pastasCidades = {}; // { "Maringá": "driveId", "Porto Rico": "driveId" }
let tabAtiva = "viewer";

let threeRenderer = null, threeScene = null, threeCamera = null, threeAnimId = null;
let wireMode = false, autoRotate = false, meshes = [];
let isDragging = false, prevMouseX = 0, prevMouseY = 0;
let camTheta = 0.5, camPhi = 0.8, camRadius = 10;

// ============================================================
// INICIALIZAÇÃO
// ============================================================
window.gapiLoaded = function() {
  gapi.load("client", async () => {
    await gapi.client.init({ discoveryDocs: [DISCOVERY_DOC] });
    gapiInited = true;
    verificarTokenSalvo();
  });
};

window.gisLoaded = function() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback: async (resp) => {
      if (resp.error) { console.error(resp); return; }
      accessToken = resp.access_token;
      gapi.client.setToken({ access_token: accessToken });
      localStorage.setItem("mc_token", JSON.stringify({
        access_token: accessToken,
        expiry: Date.now() + (resp.expires_in - 60) * 1000
      }));
      await carregarUsuario();
    }
  });
  gisInited = true;
};

function verificarTokenSalvo() {
  try {
    const saved = localStorage.getItem("mc_token");
    if (saved) {
      const { access_token, expiry } = JSON.parse(saved);
      if (Date.now() < expiry) {
        accessToken = access_token;
        gapi.client.setToken({ access_token });
        carregarUsuario();
        return;
      }
    }
  } catch (_) {}
  showScreen("login");
}

async function carregarUsuario() {
  try {
    const resp = await fetch("https://people.googleapis.com/v1/people/me?personFields=emailAddresses,names", {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || "Erro");

    const email = data.emailAddresses?.[0]?.value || "";
    const nome = data.names?.[0]?.displayName || email;

    if (!CONFIG.EMAILS_AUTORIZADOS.includes(email.toLowerCase())) {
      localStorage.removeItem("mc_token");
      gapi.client.setToken(null);
      const err = document.getElementById("login-error");
      err.textContent = `Acesso negado. A conta ${email} não tem permissão.`;
      err.style.display = "block";
      showScreen("login");
      return;
    }

    usuarioAtual = { email, nome };
    document.getElementById("sidebar-username").textContent = nome;
    showScreen("app");
    await garantirEstruturaDrive();
    await carregarObras();
  } catch (e) {
    console.error("Erro ao carregar usuário:", e);
    localStorage.removeItem("mc_token");
    showScreen("login");
  }
}

// ============================================================
// AUTH
// ============================================================
window.fazerLogin = () => {
  if (!gapiInited || !gisInited) { setTimeout(fazerLogin, 500); return; }
  tokenClient.requestAccessToken({ prompt: "select_account" });
};

window.logout = () => {
  if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
  gapi.client.setToken(null);
  localStorage.removeItem("mc_token");
  accessToken = null; usuarioAtual = null; obraAtiva = null;
  pastaRaizId = null; pastasCidades = {};
  destruirViewer();
  showScreen("login");
};

function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(`screen-${name}`).classList.add("active");
}

// ============================================================
// GOOGLE DRIVE — Estrutura de pastas
// MC Obras 3D / Maringá / [obra]
// MC Obras 3D / Porto Rico / [obra]
// ============================================================
async function garantirEstruturaDrive() {
  // Pasta raiz
  const res = await gapi.client.drive.files.list({
    q: `name='${CONFIG.PASTA_RAIZ_NOME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id)"
  });
  if (res.result.files.length > 0) {
    pastaRaizId = res.result.files[0].id;
  } else {
    const c = await gapi.client.drive.files.create({
      resource: { name: CONFIG.PASTA_RAIZ_NOME, mimeType: "application/vnd.google-apps.folder" },
      fields: "id"
    });
    pastaRaizId = c.result.id;
  }

  // Pastas de cada cidade
  for (const cidade of CIDADES) {
    const rc = await gapi.client.drive.files.list({
      q: `name='${cidade}' and '${pastaRaizId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id)"
    });
    if (rc.result.files.length > 0) {
      pastasCidades[cidade] = rc.result.files[0].id;
    } else {
      const cc = await gapi.client.drive.files.create({
        resource: { name: cidade, mimeType: "application/vnd.google-apps.folder", parents: [pastaRaizId] },
        fields: "id"
      });
      pastasCidades[cidade] = cc.result.id;
    }
  }
}

// ============================================================
// OBRAS
// ============================================================
function getObrasLocal() {
  try { return JSON.parse(localStorage.getItem("mc_obras") || "[]"); } catch { return []; }
}
function salvarObrasLocal(obras) { localStorage.setItem("mc_obras", JSON.stringify(obras)); }

async function carregarObras() {
  const listEl = document.getElementById("sidebar-obras");
  listEl.innerHTML = `<div class="loading-list">Carregando...</div>`;
  try {
    const obrasLocais = getObrasLocal();
    const todasObras = {};

    for (const cidade of CIDADES) {
      const res = await gapi.client.drive.files.list({
        q: `'${pastasCidades[cidade]}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id, name, createdTime)",
        orderBy: "createdTime desc"
      });
      todasObras[cidade] = res.result.files.map(pasta => {
        const local = obrasLocais.find(o => o.driveId === pasta.id) || {};
        return { driveId: pasta.id, nome: pasta.name, cidade, cliente: local.cliente || "", endereco: local.endereco || "", status: local.status || "Em andamento", obs: local.obs || "" };
      });
    }
    renderSidebar(todasObras);
  } catch (e) {
    listEl.innerHTML = `<div class="loading-list" style="color:#C05050">Erro ao carregar</div>`;
    console.error(e);
  }
}

function renderSidebar(todasObras) {
  const listEl = document.getElementById("sidebar-obras");
  const dotMap = { "Em andamento": "dot-andamento", "Concluído": "dot-concluido", "Pausado": "dot-pausado", "Planejamento": "dot-planejamento" };
  let html = "";

  for (const cidade of CIDADES) {
    const obras = todasObras[cidade] || [];
    html += `<div class="cidade-section-title">${cidade.toUpperCase()}</div>`;
    if (!obras.length) {
      html += `<div class="loading-list" style="font-size:11px;padding:6px 12px;">Nenhuma obra</div>`;
    } else {
      html += obras.map(o => `
        <div class="obra-item ${obraAtiva?.driveId === o.driveId ? "active" : ""}" onclick="selecionarObra('${o.driveId}', '${o.cidade}')">
          <div class="obra-item-name">${o.nome}</div>
          <div class="obra-item-meta"><span class="status-dot ${dotMap[o.status] || "dot-planejamento"}"></span>${o.status}</div>
        </div>
      `).join("");
    }
  }
  listEl.innerHTML = html;

  // Salva para uso no menu mobile
  todasObrasMobile = todasObras;
}

window.selecionarObra = async (driveId, cidade) => {
  destruirViewer();
  const obrasLocais = getObrasLocal();
  const local = obrasLocais.find(o => o.driveId === driveId) || {};
  const res = await gapi.client.drive.files.get({ fileId: driveId, fields: "id,name" });
  obraAtiva = { driveId, nome: res.result.name, cidade, cliente: local.cliente || "", endereco: local.endereco || "", status: local.status || "Em andamento", obs: local.obs || "" };

  document.getElementById("obra-nome-titulo").textContent = obraAtiva.nome;
  document.getElementById("obra-cliente-label").textContent = obraAtiva.cliente ? `${obraAtiva.cliente} · ${cidade}` : cidade;
  const sb = document.getElementById("obra-status-label");
  sb.textContent = obraAtiva.status;
  const cls = { "Em andamento": "badge-andamento", "Concluído": "badge-concluido", "Pausado": "badge-pausado", "Planejamento": "badge-planejamento" };
  sb.className = "status-badge " + (cls[obraAtiva.status] || "badge-planejamento");
  document.getElementById("info-nome").value = obraAtiva.nome;
  document.getElementById("info-cliente").value = obraAtiva.cliente;
  document.getElementById("info-endereco").value = obraAtiva.endereco;
  document.getElementById("info-status").value = obraAtiva.status;
  document.getElementById("info-obs").value = obraAtiva.obs;
  document.getElementById("info-cidade").value = obraAtiva.cidade;

  document.getElementById("empty-state").style.display = "none";
  document.getElementById("obra-panel").classList.add("visible");
  setTab("viewer", document.querySelector(".tab"));
  carregarArquivos();
  document.querySelectorAll(".obra-item").forEach(el => el.classList.toggle("active", el.getAttribute("onclick")?.includes(driveId)));
};

window.abrirModalNovaObra = () => { document.getElementById("modal-obra").style.display = "flex"; document.getElementById("nova-nome").focus(); };
window.fecharModalObra = (e) => { if (e && e.target !== document.getElementById("modal-obra")) return; document.getElementById("modal-obra").style.display = "none"; };

window.criarObra = async () => {
  const nome = document.getElementById("nova-nome").value.trim();
  const cliente = document.getElementById("nova-cliente").value.trim();
  const endereco = document.getElementById("nova-endereco").value.trim();
  const status = document.getElementById("nova-status").value;
  const cidade = document.getElementById("nova-cidade").value;
  const errEl = document.getElementById("nova-error");
  errEl.style.display = "none";
  if (!nome || !cliente) { errEl.textContent = "Preencha nome e cliente."; errEl.style.display = "block"; return; }
  try {
    const res = await gapi.client.drive.files.create({
      resource: { name: nome, mimeType: "application/vnd.google-apps.folder", parents: [pastasCidades[cidade]] },
      fields: "id"
    });
    const obras = getObrasLocal();
    obras.unshift({ driveId: res.result.id, nome, cliente, endereco, status, cidade, obs: "" });
    salvarObrasLocal(obras);
    document.getElementById("modal-obra").style.display = "none";
    ["nova-nome","nova-cliente","nova-endereco"].forEach(id => document.getElementById(id).value = "");
    await carregarObras();
  } catch (e) { errEl.textContent = "Erro ao criar obra."; errEl.style.display = "block"; console.error(e); }
};

window.salvarInfo = async () => {
  if (!obraAtiva) return;
  const novoNome = document.getElementById("info-nome").value.trim();
  const novaCidade = document.getElementById("info-cidade").value;
  const dados = {
    driveId: obraAtiva.driveId, nome: novoNome, cidade: novaCidade,
    cliente: document.getElementById("info-cliente").value.trim(),
    endereco: document.getElementById("info-endereco").value.trim(),
    status: document.getElementById("info-status").value,
    obs: document.getElementById("info-obs").value.trim()
  };
  try {
    // Renomeia pasta se necessário
    if (novoNome !== obraAtiva.nome) {
      await gapi.client.drive.files.update({ fileId: obraAtiva.driveId, resource: { name: novoNome } });
    }
    // Move para outra cidade se necessário
    if (novaCidade !== obraAtiva.cidade) {
      await gapi.client.drive.files.update({
        fileId: obraAtiva.driveId,
        addParents: pastasCidades[novaCidade],
        removeParents: pastasCidades[obraAtiva.cidade],
        fields: "id"
      });
    }
    const obras = getObrasLocal();
    const idx = obras.findIndex(o => o.driveId === obraAtiva.driveId);
    if (idx >= 0) obras[idx] = dados; else obras.unshift(dados);
    salvarObrasLocal(obras);
    obraAtiva = { ...obraAtiva, ...dados };
    document.getElementById("obra-nome-titulo").textContent = dados.nome;
    document.getElementById("obra-cliente-label").textContent = dados.cliente ? `${dados.cliente} · ${dados.cidade}` : dados.cidade;
    const sb = document.getElementById("obra-status-label");
    sb.textContent = dados.status;
    const cls = { "Em andamento": "badge-andamento", "Concluído": "badge-concluido", "Pausado": "badge-pausado", "Planejamento": "badge-planejamento" };
    sb.className = "status-badge " + (cls[dados.status] || "badge-planejamento");
    const saved = document.getElementById("info-saved");
    saved.style.display = "block";
    setTimeout(() => saved.style.display = "none", 2500);
    await carregarObras();
  } catch (e) { console.error(e); }
};

window.excluirObra = async () => {
  if (!obraAtiva || !confirm(`Excluir "${obraAtiva.nome}"?`)) return;
  try {
    await gapi.client.drive.files.delete({ fileId: obraAtiva.driveId });
    const obras = getObrasLocal().filter(o => o.driveId !== obraAtiva.driveId);
    salvarObrasLocal(obras);
    obraAtiva = null; destruirViewer();
    document.getElementById("obra-panel").classList.remove("visible");
    document.getElementById("empty-state").style.display = "flex";
    await carregarObras();
  } catch (e) { alert("Erro ao excluir."); console.error(e); }
};

window.abrirNoDrive = () => { if (obraAtiva) window.open(`https://drive.google.com/drive/folders/${obraAtiva.driveId}`, "_blank"); };

// ============================================================
// TABS
// ============================================================
window.setTab = (tab, el) => {
  tabAtiva = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  if (el) el.classList.add("active");
  document.querySelectorAll(".tab-content").forEach(c => c.style.display = "none");
  const target = document.getElementById(`tab-${tab}`);
  if (target) target.style.display = "flex";
  if (tab === "arquivos") carregarArquivos();
};

// ============================================================
// ARQUIVOS
// ============================================================
async function carregarArquivos() {
  if (!obraAtiva) return;
  const grid = document.getElementById("files-grid");
  grid.innerHTML = `<div class="loading-files">Carregando arquivos do Drive...</div>`;
  try {
    const res = await gapi.client.drive.files.list({
      q: `'${obraAtiva.driveId}' in parents and trashed=false`,
      fields: "files(id, name, size, mimeType)", orderBy: "createdTime desc"
    });
    const arquivos = res.result.files.filter(f => f.mimeType !== "application/vnd.google-apps.folder");
    if (!arquivos.length) { grid.innerHTML = `<div class="loading-files">Nenhum arquivo ainda.<br><br>Clique em "Enviar arquivo" para adicionar.</div>`; return; }
    grid.innerHTML = arquivos.map(a => {
      const ext = a.name.split(".").pop().toLowerCase();
      const tamanho = a.size ? (a.size/1024/1024).toFixed(1)+" MB" : "";
      return `
        <div class="file-card">
          <div class="file-card-icon icon-${ext}">${ext.toUpperCase()}</div>
          <div class="file-card-name">${a.name}</div>
          <div style="font-size:11px;color:var(--text-muted)">${tamanho}</div>
          <div class="file-card-actions">
            <button class="btn-mini" onclick="visualizarArquivoDrive('${a.id}','${ext}','${a.name}','${obraAtiva.driveId}')">Visualizar 3D</button>
            <button class="btn-mini" onclick="compartilharArquivo('${a.id}','${ext}','${a.name}')" style="background:var(--bege-bg);border-color:var(--border-vinho);color:var(--terra-dark)">🔗 Link</button>
            <button class="btn-mini danger" onclick="excluirArquivo('${a.id}','${a.name}')">Excluir</button>
          </div>
        </div>`;
    }).join("");
  } catch (e) { grid.innerHTML = `<div class="loading-files" style="color:#A83030">Erro ao carregar.</div>`; console.error(e); }
}

window.excluirArquivo = async (fileId, nome) => {
  if (!confirm(`Excluir "${nome}"?`)) return;
  await gapi.client.drive.files.delete({ fileId });
  carregarArquivos();
};

// ============================================================
// UPLOAD
// ============================================================
window.abrirUpload = () => { document.getElementById("modal-upload").style.display="flex"; document.getElementById("upload-progress").style.display="none"; document.getElementById("upload-error").style.display="none"; };
window.fecharUpload = (e) => { if(e && e.target!==document.getElementById("modal-upload")) return; document.getElementById("modal-upload").style.display="none"; };
window.handleDrop = (e) => { e.preventDefault(); document.getElementById("upload-zone").classList.remove("drag"); if(e.dataTransfer.files[0]) enviarArquivo(e.dataTransfer.files[0]); };
window.handleFileSelect = (e) => { if(e.target.files[0]) enviarArquivo(e.target.files[0]); };

async function enviarArquivo(file) {
  if (!obraAtiva) return;
  const ext = file.name.split(".").pop().toLowerCase();
  if (!["obj","gltf","glb","mtl"].includes(ext)) { document.getElementById("upload-error").textContent="Formato não suportado. Use .obj, .gltf, .glb ou .mtl"; document.getElementById("upload-error").style.display="block"; return; }
  const fill = document.getElementById("progress-fill");
  const label = document.getElementById("progress-label");
  document.getElementById("upload-progress").style.display="block";
  fill.style.width="10%"; label.textContent="Enviando para o Drive...";
  try {
    const metadata = { name: file.name, parents: [obraAtiva.driveId] };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type:"application/json" }));
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name");
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.upload.onprogress = (e) => { if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);fill.style.width=p+"%";label.textContent=`Enviando... ${p}%`;} };
    xhr.onload = () => {
      if(xhr.status===200){fill.style.width="100%";label.textContent="Salvo no Drive!";setTimeout(()=>{document.getElementById("modal-upload").style.display="none";document.getElementById("file-input").value="";carregarArquivos();if(tabAtiva!=="arquivos")setTab("arquivos",document.querySelectorAll(".tab")[1]);},800);}
      else{document.getElementById("upload-error").textContent="Erro no upload.";document.getElementById("upload-error").style.display="block";}
    };
    xhr.send(form);
  } catch(e){document.getElementById("upload-error").textContent="Erro no upload.";document.getElementById("upload-error").style.display="block";console.error(e);}
}

// ============================================================
// VISUALIZADOR 3D
// ============================================================
window.visualizarArquivoDrive = async (fileId, ext, nome, pastaId) => {
  setTab("viewer", document.querySelectorAll(".tab")[0]);
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  
  // Procura arquivo MTL correspondente na mesma pasta
  let mtlUrl = null;
  if(ext === "obj" && pastaId) {
    try {
      const nomeSemExt = nome.replace(/\.obj$/i, "");
      const res = await gapi.client.drive.files.list({
        q: `'${pastaId}' in parents and name='${nomeSemExt}.mtl' and trashed=false`,
        fields: "files(id, name)"
      });
      if(res.result.files.length > 0) {
        mtlUrl = `https://www.googleapis.com/drive/v3/files/${res.result.files[0].id}?alt=media`;
      }
    } catch(e) { console.log("MTL não encontrado"); }
  }
  setTimeout(() => iniciarViewer(url, ext, nome, mtlUrl), 100);
};

// Estado do mouse
let mouseBtn = -1; // 0=esquerdo(órbita), 1=meio(pan), 2=direito(pan)
let panX = 0, panY = 0;
let target = null; // ponto de foco da câmera

function iniciarViewer(url, ext, nome, mtlUrl) {
  destruirViewer();
  wireMode=false; autoRotate=false; meshes=[];
  target = new THREE.Vector3(0,0,0);
  const canvas=document.getElementById("three-canvas");
  const wrap=canvas.parentElement;
  canvas.style.display="block";
  document.getElementById("viewer-empty").style.display="none";
  document.getElementById("viewer-controls").style.display="flex";
  document.getElementById("viewer-label").textContent=nome;
  document.getElementById("viewer-label").style.display="block";
  const w=wrap.clientWidth||800, h=wrap.clientHeight||500;

  threeScene=new THREE.Scene();
  threeScene.background=new THREE.Color(0x1A0E0E);
  threeCamera=new THREE.PerspectiveCamera(45,w/h,0.01,2000);
  threeRenderer=new THREE.WebGLRenderer({canvas,antialias:true});
  threeRenderer.setSize(w,h);
  threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  threeRenderer.shadowMap.enabled=false; // Desativado para evitar artefatos

  // Iluminação uniforme com leve sombreamento para arestas
  threeScene.add(new THREE.AmbientLight(0xffffff, 0.7));
  // Hemisférica suave dá leve variação topo/baixo
  threeScene.add(new THREE.HemisphereLight(0xffffff, 0xdddddd, 0.5));
  // 4 luzes direcionais dos cantos superiores (iguais = sem lado escuro)
  const cornerLights = [[10,15,10],[-10,15,10],[10,15,-10],[-10,15,-10]];
  cornerLights.forEach(p => {
    const l = new THREE.DirectionalLight(0xffffff, 0.25);
    l.position.set(p[0], p[1], p[2]);
    threeScene.add(l);
  });
  threeRenderer.sortObjects = true;


  threeScene.add(new THREE.GridHelper(50,50,0x2A1008,0x1A0805));

  carregarModelo(url, ext, mtlUrl);

  // Controles de mouse melhorados
  canvas.addEventListener("mousedown", e=>{
    mouseBtn=e.button;
    isDragging=true;
    prevMouseX=e.clientX;
    prevMouseY=e.clientY;
    e.preventDefault();
  });
  window.addEventListener("mouseup", ()=>{ isDragging=false; mouseBtn=-1; });
  window.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("wheel", onWheel, {passive:false});
  canvas.addEventListener("contextmenu", e=>e.preventDefault());

  // Touch para mobile
  canvas.addEventListener("touchstart", onTouchStart, {passive:false});
  canvas.addEventListener("touchmove", onTouchMove, {passive:false});
  canvas.addEventListener("touchend", ()=>isDragging=false);

  camTheta=0.6; camPhi=0.7; camRadius=15; panX=0; panY=0;
  updateCamera();

  function animate(){threeAnimId=requestAnimationFrame(animate);if(autoRotate){camTheta+=0.003;updateCamera();}threeRenderer.render(threeScene,threeCamera);}
  animate();
}

function carregarModelo(url, ext, mtlUrl) {
  if(ext==="obj") {
    // Carrega MTL + OBJ com cores
    const loadObj = (mtlMat) => {
      const s=document.createElement("script");
      s.src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/OBJLoader.js";
      s.onload=()=>{
        const loader=new THREE.OBJLoader();
        if(mtlMat) loader.setMaterials(mtlMat);
        loader.setRequestHeader({"Authorization":`Bearer ${accessToken}`});
        loader.load(url, obj=>{
          centralizarModelo(obj);
          threeScene.add(obj);
          obj.traverse(c=>{
            // Esconde apenas linhas puras (LineSegments, Line, etc.)
            if(c.isLine || c.isLineSegments || c.isLineLoop){
              c.visible = false;
              return;
            }

            if(c.isMesh){
              // Aplica configurações de material
              const mats = Array.isArray(c.material) ? c.material : [c.material];
              mats.forEach(m => {
                if(!m) return;
                m.side = THREE.DoubleSide;
                m.depthWrite = true;
                m.transparent = m.opacity < 0.99;
                m.alphaTest = 0.05;
                // Sem brilho — material fosco uniforme tipo SketchUp
                m.shininess = 0;
                if(m.specular) m.specular.setHex(0x000000);
              });

              if(!mtlMat){
                c.material = new THREE.MeshPhongMaterial({color: 0xCCCCCC, side: THREE.DoubleSide});
              }

              c.castShadow = false;
              c.receiveShadow = false;
              meshes.push(c);
            }
          });
        }, undefined, e=>console.error(e));
      };
      document.head.appendChild(s);
    };

    if(mtlUrl) {
      // Carrega MTL primeiro
      const s=document.createElement("script");
      s.src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/MTLLoader.js";
      s.onload=()=>{
        const mtlLoader=new THREE.MTLLoader();
        mtlLoader.setRequestHeader({"Authorization":`Bearer ${accessToken}`});
        mtlLoader.load(mtlUrl, mat=>{ mat.preload(); loadObj(mat); }, undefined, ()=>loadObj(null));
      };
      document.head.appendChild(s);
    } else {
      loadObj(null);
    }
  } else {
    const s=document.createElement("script");
    s.src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js";
    s.onload=()=>{
      const l=new THREE.GLTFLoader();
      l.setRequestHeader({"Authorization":`Bearer ${accessToken}`});
      l.load(url,gltf=>{
        centralizarModelo(gltf.scene);
        threeScene.add(gltf.scene);
        gltf.scene.traverse(c=>{if(c.isMesh){meshes.push(c);c.material.side=THREE.DoubleSide;}});
      },undefined,e=>console.error(e));
    };
    document.head.appendChild(s);
  }
}

function centralizarModelo(obj){
  const box=new THREE.Box3().setFromObject(obj);
  const center=box.getCenter(new THREE.Vector3());
  const size=box.getSize(new THREE.Vector3());
  const maxDim=Math.max(size.x,size.y,size.z);
  const scale=8/maxDim;
  obj.scale.setScalar(scale);
  obj.position.sub(center.multiplyScalar(scale));
  obj.position.y+=size.y*scale/2;
  target=new THREE.Vector3(0, size.y*scale/2, 0);
  camRadius=maxDim*scale*1.8;
  updateCamera();
}

let touchStartDist=0, touchStartRadius=0;
let touchPrevMidX=0, touchPrevMidY=0;
let touchPrevX=0, touchPrevY=0;

function onTouchStart(e){
  e.preventDefault();
  if(e.touches.length===1){
    // 1 dedo — órbita
    isDragging=true;
    touchPrevX=e.touches[0].clientX;
    touchPrevY=e.touches[0].clientY;
  } else if(e.touches.length===2){
    // 2 dedos — pan + zoom
    isDragging=false;
    const midX=(e.touches[0].clientX+e.touches[1].clientX)/2;
    const midY=(e.touches[0].clientY+e.touches[1].clientY)/2;
    touchPrevMidX=midX; touchPrevMidY=midY;
    touchStartDist=Math.hypot(
      e.touches[1].clientX-e.touches[0].clientX,
      e.touches[1].clientY-e.touches[0].clientY
    );
    touchStartRadius=camRadius;
  }
}

function onTouchMove(e){
  e.preventDefault();
  if(e.touches.length===1 && isDragging){
    // 1 dedo — órbita
    const dx=e.touches[0].clientX-touchPrevX;
    const dy=e.touches[0].clientY-touchPrevY;
    camTheta-=dx*0.007;
    camPhi-=dy*0.007;
    camPhi=Math.max(0.02,Math.min(Math.PI/2-0.01,camPhi));
    touchPrevX=e.touches[0].clientX;
    touchPrevY=e.touches[0].clientY;
    updateCamera();
  } else if(e.touches.length===2){
    // 2 dedos — zoom (pinça) + pan (arrastar)
    const midX=(e.touches[0].clientX+e.touches[1].clientX)/2;
    const midY=(e.touches[0].clientY+e.touches[1].clientY)/2;
    const dist=Math.hypot(
      e.touches[1].clientX-e.touches[0].clientX,
      e.touches[1].clientY-e.touches[0].clientY
    );

    // Zoom por pinça
    camRadius=touchStartRadius*(touchStartDist/dist);
    camRadius=Math.max(1,Math.min(100,camRadius));

    // Pan pelo movimento do ponto médio entre os dois dedos
    const dx=midX-touchPrevMidX;
    const dy=midY-touchPrevMidY;
    const panSpeed=camRadius*0.002;
    const right=new THREE.Vector3();
    const up=new THREE.Vector3(0,1,0);
    right.crossVectors(threeCamera.position.clone().sub(target),up).normalize();
    target.addScaledVector(right,-dx*panSpeed);
    target.addScaledVector(up,dy*panSpeed);

    touchPrevMidX=midX; touchPrevMidY=midY;
    updateCamera();
  }
}

function onMouseMove(e){
  if(!isDragging) return;
  const dx=e.clientX-prevMouseX;
  const dy=e.clientY-prevMouseY;
  if(mouseBtn===0){
    // Botão esquerdo — órbita
    camTheta-=dx*0.006;
    camPhi-=dy*0.006;
    camPhi=Math.max(0.02,Math.min(Math.PI/2-0.01,camPhi));
  } else if(mouseBtn===1||mouseBtn===2){
    // Botão meio ou direito — pan
    const panSpeed=camRadius*0.001;
    const right=new THREE.Vector3();
    const up=new THREE.Vector3(0,1,0);
    right.crossVectors(threeCamera.position.clone().sub(target),up).normalize();
    target.addScaledVector(right, -dx*panSpeed);
    target.addScaledVector(up, dy*panSpeed);
  }
  prevMouseX=e.clientX; prevMouseY=e.clientY;
  updateCamera();
}

function onWheel(e){
  e.preventDefault();
  camRadius=Math.max(1,Math.min(100,camRadius+e.deltaY*0.03));
  updateCamera();
}

function updateCamera(){
  if(!threeCamera||!target) return;
  threeCamera.position.set(
    target.x + camRadius*Math.sin(camPhi)*Math.sin(camTheta),
    target.y + camRadius*Math.cos(camPhi),
    target.z + camRadius*Math.sin(camPhi)*Math.cos(camTheta)
  );
  threeCamera.lookAt(target);
}

window.resetCamera=()=>{
  camTheta=0.6; camPhi=0.7; camRadius=15; panX=0; panY=0;
  if(target) target.set(0,0,0);
  updateCamera();
};
window.toggleWireframe=()=>{wireMode=!wireMode;meshes.forEach(m=>{if(m.material)m.material.wireframe=wireMode;});};
window.toggleAutoRotate=()=>{autoRotate=!autoRotate;document.getElementById("btn-rotate").textContent=autoRotate?"⏸":"▶";};

let isFakeFullscreen = false;



// ============================================================
// COMPARTILHAMENTO — Gera link público do visualizador
// ============================================================
window.compartilharArquivo = async (fileId, ext, nome) => {
  if (!obraAtiva) return;

  // Modal de carregando
  const modal = document.createElement("div");
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;";
  modal.innerHTML = `
    <div style="background:var(--bege-white);border-radius:4px;padding:28px;max-width:420px;width:90%;border:1px solid var(--border);">
      <h3 style="font-size:13px;font-weight:700;color:var(--terra-dark);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border);">
        🔗 Link de compartilhamento
      </h3>
      <p id="share-status" style="font-size:13px;color:var(--text-mid);margin-bottom:16px;">Tornando arquivo público...</p>
      <div id="share-link-wrap" style="display:none;">
        <div style="background:var(--bege-bg);border:1px solid var(--border);border-radius:3px;padding:10px 12px;font-family:monospace;font-size:11px;color:var(--text-mid);word-break:break-all;margin-bottom:14px;line-height:1.6;" id="share-link-text"></div>
        <div style="display:flex;gap:8px;">
          <button onclick="copiarLink()" style="flex:1;padding:9px;background:var(--terra-dark);color:#fff;border:none;border-radius:2px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;">📋 Copiar link</button>
          <button onclick="this.closest('[data-modal]').remove()" style="padding:9px 14px;background:transparent;border:1px solid var(--border);border-radius:2px;font-size:11px;cursor:pointer;">Fechar</button>
        </div>
        <p style="font-size:10px;color:var(--text-muted);margin-top:10px;line-height:1.5;">
          ⚠️ Qualquer pessoa com este link poderá visualizar o modelo 3D sem precisar fazer login.
        </p>
      </div>
      <div id="share-error" style="display:none;">
        <p style="font-size:12px;color:#A83030;margin-bottom:12px;">Erro ao gerar link. Tente novamente.</p>
        <button onclick="this.closest('[data-modal]').remove()" style="padding:7px 14px;background:transparent;border:1px solid var(--border);border-radius:2px;font-size:11px;cursor:pointer;">Fechar</button>
      </div>
    </div>
  `;
  modal.setAttribute("data-modal", "share");
  modal.querySelector("div").style.fontFamily = "'DM Sans', sans-serif";
  document.body.appendChild(modal);

  try {
    // Torna o arquivo público (anyone with link can view)
    await gapi.client.drive.permissions.create({
      fileId: fileId,
      resource: { role: "reader", type: "anyone" }
    });

    // Procura MTL correspondente e também torna público
    let mtlId = null;
    const nomeSemExt = nome.replace(/\.obj$/i, "");
    try {
      const res = await gapi.client.drive.files.list({
        q: `'${obraAtiva.driveId}' in parents and name='${nomeSemExt}.mtl' and trashed=false`,
        fields: "files(id)"
      });
      if (res.result.files.length > 0) {
        mtlId = res.result.files[0].id;
        await gapi.client.drive.permissions.create({
          fileId: mtlId,
          resource: { role: "reader", type: "anyone" }
        });
      }
    } catch(_) {}

    // Monta URL do viewer público
    const base = window.location.origin + window.location.pathname.replace("index.html","").replace(/\/$/, "");
    const params = new URLSearchParams({
      fileId,
      ext,
      nome: obraAtiva.nome,
      cidade: obraAtiva.cidade || ""
    });
    if (mtlId) params.set("mtlId", mtlId);
    const link = `${base}/viewer.html?${params.toString()}`;

    // Mostra link
    document.getElementById("share-status").style.display = "none";
    document.getElementById("share-link-text").textContent = link;
    window._shareLink = link;
    document.getElementById("share-link-wrap").style.display = "block";

  } catch(e) {
    console.error(e);
    document.getElementById("share-status").style.display = "none";
    document.getElementById("share-error").style.display = "block";
  }
};

window.copiarLink = () => {
  if (window._shareLink) {
    navigator.clipboard.writeText(window._shareLink).then(() => {
      const btn = document.querySelector("[data-modal] button");
      if (btn) { btn.textContent = "✅ Copiado!"; setTimeout(() => btn.textContent = "📋 Copiar link", 2000); }
    });
  }
};


// ============================================================
// MENU MOBILE — OBRAS POR CIDADE
// ============================================================
let todasObrasMobile = {};

function toggleMobileMenu() {
  const panel = document.getElementById("mobile-menu-panel");
  const overlay = document.getElementById("mobile-overlay");
  const arrow = document.getElementById("mobile-trigger-arrow");
  const isOpen = panel.style.display !== "none";
  if (isOpen) {
    fecharMobileMenu();
  } else {
    panel.style.display = "block";
    overlay.classList.add("open");
    arrow.textContent = "▲";
    renderMobileMenu();
  }
}

function fecharMobileMenu() {
  const panel = document.getElementById("mobile-menu-panel");
  const overlay = document.getElementById("mobile-overlay");
  const arrow = document.getElementById("mobile-trigger-arrow");
  panel.style.display = "none";
  overlay.classList.remove("open");
  if(arrow) arrow.textContent = "▼";
}

function renderMobileMenu() {
  const container = document.getElementById("mobile-menu-content");
  const dotMap = { "Em andamento": "badge-andamento", "Concluído": "badge-concluido", "Pausado": "badge-pausado", "Planejamento": "badge-planejamento" };
  let html = "";

  for (const cidade of CIDADES) {
    const obras = todasObrasMobile[cidade] || [];
    const cidadeId = cidade.replace(/\s/g, "_");
    html += `
      <button class="mobile-cidade-btn" onclick="toggleCidadeMobile('${cidadeId}')" id="btn-cidade-${cidadeId}">
        <span>📍 ${cidade} <span style="font-size:10px;opacity:0.5;font-weight:400">(${obras.length} obra${obras.length !== 1 ? 's' : ''})</span></span>
        <span class="arrow">▶</span>
      </button>
      <div class="mobile-obras-list" id="list-cidade-${cidadeId}">
        ${obras.length === 0 ? `<div style="padding:12px 24px;color:rgba(255,255,255,0.3);font-size:12px;">Nenhuma obra</div>` : 
          obras.map(o => `
            <button class="mobile-obra-item ${obraAtiva?.driveId === o.driveId ? 'active' : ''}" 
                    onclick="selecionarObraMobile('${o.driveId}', '${o.cidade}')">
              <span>${o.nome}</span>
              <span class="obra-status ${dotMap[o.status] || 'badge-planejamento'}" 
                    style="background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.7)">${o.status}</span>
            </button>
          `).join('')
        }
        <button class="mobile-nova-obra" onclick="fecharMobileMenu(); abrirModalNovaObraComCidade('${cidade}')">
          + Nova obra em ${cidade}
        </button>
      </div>
    `;
  }

  container.innerHTML = html;

  // Abre a cidade da obra ativa automaticamente
  if (obraAtiva) {
    const cidadeId = obraAtiva.cidade.replace(/\s/g, "_");
    toggleCidadeMobile(cidadeId);
  }
}

function toggleCidadeMobile(cidadeId) {
  const list = document.getElementById(`list-cidade-${cidadeId}`);
  const btn = document.getElementById(`btn-cidade-${cidadeId}`);
  if (!list) return;
  const isOpen = list.classList.contains("open");
  // Fecha todas
  document.querySelectorAll(".mobile-obras-list").forEach(l => l.classList.remove("open"));
  document.querySelectorAll(".mobile-cidade-btn").forEach(b => b.classList.remove("open"));
  // Abre a clicada se estava fechada
  if (!isOpen) {
    list.classList.add("open");
    btn.classList.add("open");
  }
}

function selecionarObraMobile(driveId, cidade) {
  fecharMobileMenu();
  selecionarObra(driveId, cidade);
}

window.abrirModalNovaObraComCidade = (cidade) => {
  document.getElementById("nova-cidade").value = cidade;
  abrirModalNovaObra();
};

window.toggleFullscreen = () => {
  const wrap = document.getElementById("three-canvas").parentElement;
  const btn = document.getElementById("btn-fullscreen");

  // iOS Safari não suporta fullscreen API — usa CSS fullscreen simulado
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

  if (isIOS) {
    if (!isFakeFullscreen) {
      // Entra em "tela cheia" via CSS
      wrap.classList.add("ios-fullscreen");
      document.body.classList.add("ios-fullscreen-active");
      btn.textContent = "✕";
      isFakeFullscreen = true;
      setTimeout(() => ajustarRenderer(), 100);
    } else {
      wrap.classList.remove("ios-fullscreen");
      document.body.classList.remove("ios-fullscreen-active");
      btn.textContent = "⛶";
      isFakeFullscreen = false;
      setTimeout(() => ajustarRenderer(), 100);
    }
    return;
  }

  // Android e desktop — usa API nativa
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    if (wrap.requestFullscreen) wrap.requestFullscreen();
    else if (wrap.webkitRequestFullscreen) wrap.webkitRequestFullscreen();
    btn.textContent = "✕";
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    btn.textContent = "⛶";
  }
};

// Atualiza renderer ao entrar/sair tela cheia nativa
document.addEventListener("fullscreenchange", ajustarRenderer);
document.addEventListener("webkitfullscreenchange", ajustarRenderer);

// Atualiza renderer ao rotacionar o celular
window.addEventListener("orientationchange", () => setTimeout(ajustarRenderer, 300));
window.addEventListener("resize", ajustarRenderer);

function ajustarRenderer() {
  if (!threeRenderer || !threeCamera) return;
  const canvas = document.getElementById("three-canvas");
  const wrap = canvas.parentElement;
  // Usa dimensões reais da tela em fullscreen
  const w = (document.fullscreenElement || document.webkitFullscreenElement || isFakeFullscreen)
    ? window.innerWidth
    : wrap.clientWidth;
  const h = (document.fullscreenElement || document.webkitFullscreenElement || isFakeFullscreen)
    ? window.innerHeight
    : wrap.clientHeight;
  if(w > 0 && h > 0) {
    threeRenderer.setSize(w, h);
    threeCamera.aspect = w / h;
    threeCamera.updateProjectionMatrix();
  }
  const btn = document.getElementById("btn-fullscreen");
  if (btn) {
    const isFs = document.fullscreenElement || document.webkitFullscreenElement || isFakeFullscreen;
    btn.textContent = isFs ? "✕" : "⛶";
  }
}

function destruirViewer(){
  cancelAnimationFrame(threeAnimId);window.removeEventListener("mousemove",onMouseMove);
  if(threeRenderer){threeRenderer.dispose();threeRenderer=null;}
  threeScene=null;threeCamera=null;meshes=[];
  const canvas=document.getElementById("three-canvas");if(canvas)canvas.style.display="none";
  const empty=document.getElementById("viewer-empty");if(empty)empty.style.display="flex";
  const ctrl=document.getElementById("viewer-controls");if(ctrl)ctrl.style.display="none";
  const lbl=document.getElementById("viewer-label");if(lbl)lbl.style.display="none";
}
