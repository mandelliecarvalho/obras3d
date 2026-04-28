// ============================================================
// MANDELLI & CARVALHO — Plataforma de Arquivos
// Google Drive API + Google Identity Services
// ============================================================

const SCOPES = "https://www.googleapis.com/auth/drive";
const DISCOVERY_DOC = "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest";

let gapiInited = false;
let gisInited = false;
let tokenClient = null;
let usuarioAtual = null;
let obraAtiva = null;
let pastaRaizId = null;
let tabAtiva = "viewer";

// Three.js
let threeRenderer = null, threeScene = null, threeCamera = null, threeAnimId = null;
let wireMode = false, autoRotate = false, meshes = [];
let isDragging = false, prevMouseX = 0, prevMouseY = 0;
let camTheta = 0.5, camPhi = 0.8, camRadius = 10;

// ============================================================
// INICIALIZAÇÃO
// ============================================================
window.addEventListener("load", () => {
  gapi.load("client", async () => {
    await gapi.client.init({ discoveryDocs: [DISCOVERY_DOC] });
    gapiInited = true;
    verificarTokenSalvo();
  });
});

window.onGisLoaded = function() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback: async (resp) => {
      if (resp.error) { console.error(resp); return; }
      // Salva token no localStorage
      localStorage.setItem("mc_gtoken", JSON.stringify({
        token: resp.access_token,
        expiry: Date.now() + (resp.expires_in - 60) * 1000
      }));
      gapi.client.setToken({ access_token: resp.access_token });
      await carregarUsuario(resp.access_token);
    }
  });
  gisInited = true;
};

function verificarTokenSalvo() {
  try {
    const saved = localStorage.getItem("mc_gtoken");
    if (saved) {
      const { token, expiry } = JSON.parse(saved);
      if (Date.now() < expiry) {
        gapi.client.setToken({ access_token: token });
        carregarUsuario(token);
        return;
      }
    }
  } catch (_) {}
  showScreen("login");
}

async function carregarUsuario(accessToken) {
  try {
    // Usa a API do Google para pegar info do usuário
    const resp = await gapi.client.request({
      path: "https://www.googleapis.com/oauth2/v2/userinfo"
    });
    const info = resp.result;

    // Verifica e-mail autorizado
    if (!CONFIG.EMAILS_AUTORIZADOS.includes(info.email.toLowerCase())) {
      localStorage.removeItem("mc_gtoken");
      gapi.client.setToken(null);
      const err = document.getElementById("login-error");
      err.textContent = `Acesso negado. A conta ${info.email} não tem permissão.`;
      err.style.display = "block";
      showScreen("login");
      return;
    }

    usuarioAtual = info;
    document.getElementById("sidebar-username").textContent = info.name || info.email;
    showScreen("app");
    await garantirPastaRaiz();
    await carregarObras();
  } catch (e) {
    console.error("Erro ao carregar usuário:", e);
    localStorage.removeItem("mc_gtoken");
    showScreen("login");
  }
}

// ============================================================
// AUTH
// ============================================================
window.fazerLogin = () => {
  if (!gapiInited || !gisInited) { alert("Aguarde carregar..."); return; }
  tokenClient.requestAccessToken({ prompt: "select_account" });
};

window.logout = () => {
  const token = gapi.client.getToken();
  if (token) google.accounts.oauth2.revoke(token.access_token, () => {});
  gapi.client.setToken(null);
  localStorage.removeItem("mc_gtoken");
  usuarioAtual = null; obraAtiva = null; pastaRaizId = null;
  destruirViewer();
  showScreen("login");
};

function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(`screen-${name}`).classList.add("active");
}

// ============================================================
// GOOGLE DRIVE — Pasta raiz
// ============================================================
async function garantirPastaRaiz() {
  const res = await gapi.client.drive.files.list({
    q: `name='${CONFIG.PASTA_RAIZ_NOME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)"
  });
  if (res.result.files.length > 0) {
    pastaRaizId = res.result.files[0].id;
  } else {
    const created = await gapi.client.drive.files.create({
      resource: { name: CONFIG.PASTA_RAIZ_NOME, mimeType: "application/vnd.google-apps.folder" },
      fields: "id"
    });
    pastaRaizId = created.result.id;
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
    const res = await gapi.client.drive.files.list({
      q: `'${pastaRaizId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id, name, createdTime)",
      orderBy: "createdTime desc"
    });
    const pastas = res.result.files;
    const obrasLocais = getObrasLocal();
    const obras = pastas.map(pasta => {
      const local = obrasLocais.find(o => o.driveId === pasta.id) || {};
      return { driveId: pasta.id, nome: pasta.name, cliente: local.cliente || "", endereco: local.endereco || "", status: local.status || "Em andamento", obs: local.obs || "" };
    });
    renderSidebar(obras);
  } catch (e) {
    listEl.innerHTML = `<div class="loading-list" style="color:#C05050">Erro ao carregar</div>`;
    console.error(e);
  }
}

function renderSidebar(obras) {
  const listEl = document.getElementById("sidebar-obras");
  if (!obras.length) { listEl.innerHTML = `<div class="loading-list">Nenhuma obra ainda</div>`; return; }
  const dotMap = { "Em andamento": "dot-andamento", "Concluído": "dot-concluido", "Pausado": "dot-pausado", "Planejamento": "dot-planejamento" };
  listEl.innerHTML = obras.map(o => `
    <div class="obra-item ${obraAtiva?.driveId === o.driveId ? "active" : ""}" onclick="selecionarObra('${o.driveId}')">
      <div class="obra-item-name">${o.nome}</div>
      <div class="obra-item-meta"><span class="status-dot ${dotMap[o.status] || "dot-planejamento"}"></span>${o.status}</div>
    </div>
  `).join("");
}

window.selecionarObra = async (driveId) => {
  destruirViewer();
  const obrasLocais = getObrasLocal();
  const local = obrasLocais.find(o => o.driveId === driveId) || {};
  const res = await gapi.client.drive.files.get({ fileId: driveId, fields: "id,name" });
  obraAtiva = { driveId, nome: res.result.name, cliente: local.cliente || "", endereco: local.endereco || "", status: local.status || "Em andamento", obs: local.obs || "" };

  document.getElementById("obra-nome-titulo").textContent = obraAtiva.nome;
  document.getElementById("obra-cliente-label").textContent = obraAtiva.cliente;
  const sb = document.getElementById("obra-status-label");
  sb.textContent = obraAtiva.status;
  const cls = { "Em andamento": "badge-andamento", "Concluído": "badge-concluido", "Pausado": "badge-pausado", "Planejamento": "badge-planejamento" };
  sb.className = "status-badge " + (cls[obraAtiva.status] || "badge-planejamento");
  document.getElementById("info-nome").value = obraAtiva.nome;
  document.getElementById("info-cliente").value = obraAtiva.cliente;
  document.getElementById("info-endereco").value = obraAtiva.endereco;
  document.getElementById("info-status").value = obraAtiva.status;
  document.getElementById("info-obs").value = obraAtiva.obs;

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
  const errEl = document.getElementById("nova-error");
  errEl.style.display = "none";
  if (!nome || !cliente) { errEl.textContent = "Preencha nome e cliente."; errEl.style.display = "block"; return; }
  try {
    const res = await gapi.client.drive.files.create({
      resource: { name: nome, mimeType: "application/vnd.google-apps.folder", parents: [pastaRaizId] },
      fields: "id"
    });
    const obras = getObrasLocal();
    obras.unshift({ driveId: res.result.id, nome, cliente, endereco, status, obs: "" });
    salvarObrasLocal(obras);
    document.getElementById("modal-obra").style.display = "none";
    ["nova-nome","nova-cliente","nova-endereco"].forEach(id => document.getElementById(id).value = "");
    await carregarObras();
  } catch (e) { errEl.textContent = "Erro ao criar obra."; errEl.style.display = "block"; console.error(e); }
};

window.salvarInfo = async () => {
  if (!obraAtiva) return;
  const novoNome = document.getElementById("info-nome").value.trim();
  const dados = { driveId: obraAtiva.driveId, nome: novoNome, cliente: document.getElementById("info-cliente").value.trim(), endereco: document.getElementById("info-endereco").value.trim(), status: document.getElementById("info-status").value, obs: document.getElementById("info-obs").value.trim() };
  try {
    if (novoNome !== obraAtiva.nome) await gapi.client.drive.files.update({ fileId: obraAtiva.driveId, resource: { name: novoNome } });
    const obras = getObrasLocal();
    const idx = obras.findIndex(o => o.driveId === obraAtiva.driveId);
    if (idx >= 0) obras[idx] = dados; else obras.unshift(dados);
    salvarObrasLocal(obras);
    obraAtiva = { ...obraAtiva, ...dados };
    document.getElementById("obra-nome-titulo").textContent = dados.nome;
    document.getElementById("obra-cliente-label").textContent = dados.cliente;
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
    obraAtiva = null;
    destruirViewer();
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
      fields: "files(id, name, size, mimeType)",
      orderBy: "createdTime desc"
    });
    const arquivos = res.result.files.filter(f => f.mimeType !== "application/vnd.google-apps.folder");
    if (!arquivos.length) { grid.innerHTML = `<div class="loading-files">Nenhum arquivo ainda.<br><br>Clique em "Enviar arquivo" para adicionar.</div>`; return; }
    grid.innerHTML = arquivos.map(a => {
      const ext = a.name.split(".").pop().toLowerCase();
      const tamanho = a.size ? (a.size / 1024 / 1024).toFixed(1) + " MB" : "";
      return `
        <div class="file-card">
          <div class="file-card-icon icon-${ext}">${ext.toUpperCase()}</div>
          <div class="file-card-name">${a.name}</div>
          <div style="font-size:11px;color:var(--text-muted)">${tamanho}</div>
          <div class="file-card-actions">
            <button class="btn-mini" onclick="visualizarArquivoDrive('${a.id}', '${ext}', '${a.name}')">Visualizar 3D</button>
            <button class="btn-mini danger" onclick="excluirArquivo('${a.id}', '${a.name}')">Excluir</button>
          </div>
        </div>
      `;
    }).join("");
  } catch (e) { grid.innerHTML = `<div class="loading-files" style="color:#A83030">Erro ao carregar arquivos.</div>`; console.error(e); }
}

window.excluirArquivo = async (fileId, nome) => {
  if (!confirm(`Excluir "${nome}"?`)) return;
  await gapi.client.drive.files.delete({ fileId });
  carregarArquivos();
};

// ============================================================
// UPLOAD
// ============================================================
window.abrirUpload = () => { document.getElementById("modal-upload").style.display = "flex"; document.getElementById("upload-progress").style.display = "none"; document.getElementById("upload-error").style.display = "none"; };
window.fecharUpload = (e) => { if (e && e.target !== document.getElementById("modal-upload")) return; document.getElementById("modal-upload").style.display = "none"; };
window.handleDrop = (e) => { e.preventDefault(); document.getElementById("upload-zone").classList.remove("drag"); if (e.dataTransfer.files[0]) enviarArquivo(e.dataTransfer.files[0]); };
window.handleFileSelect = (e) => { if (e.target.files[0]) enviarArquivo(e.target.files[0]); };

async function enviarArquivo(file) {
  if (!obraAtiva) return;
  const ext = file.name.split(".").pop().toLowerCase();
  if (!["obj","gltf","glb"].includes(ext)) {
    document.getElementById("upload-error").textContent = "Formato não suportado. Use .obj, .gltf ou .glb";
    document.getElementById("upload-error").style.display = "block"; return;
  }
  const fill = document.getElementById("progress-fill");
  const label = document.getElementById("progress-label");
  document.getElementById("upload-progress").style.display = "block";
  fill.style.width = "10%"; label.textContent = "Enviando para o Drive...";
  try {
    const token = gapi.client.getToken().access_token;
    const metadata = { name: file.name, parents: [obraAtiva.driveId] };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name");
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const p = Math.round(e.loaded/e.total*100); fill.style.width = p+"%"; label.textContent = `Enviando... ${p}%`; } };
    xhr.onload = () => {
      if (xhr.status === 200) {
        fill.style.width = "100%"; label.textContent = "Salvo no Drive!";
        setTimeout(() => { document.getElementById("modal-upload").style.display = "none"; document.getElementById("file-input").value = ""; carregarArquivos(); if (tabAtiva !== "arquivos") setTab("arquivos", document.querySelectorAll(".tab")[1]); }, 800);
      } else {
        document.getElementById("upload-error").textContent = "Erro no upload.";
        document.getElementById("upload-error").style.display = "block";
      }
    };
    xhr.send(form);
  } catch (e) { document.getElementById("upload-error").textContent = "Erro no upload."; document.getElementById("upload-error").style.display = "block"; console.error(e); }
}

// ============================================================
// VISUALIZADOR 3D
// ============================================================
window.visualizarArquivoDrive = async (fileId, ext, nome) => {
  setTab("viewer", document.querySelectorAll(".tab")[0]);
  const token = gapi.client.getToken().access_token;
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  setTimeout(() => iniciarViewer(url, ext, nome, token), 100);
};

function iniciarViewer(url, ext, nome, token) {
  destruirViewer();
  wireMode = false; autoRotate = false; meshes = [];
  const canvas = document.getElementById("three-canvas");
  const wrap = canvas.parentElement;
  canvas.style.display = "block";
  document.getElementById("viewer-empty").style.display = "none";
  document.getElementById("viewer-controls").style.display = "flex";
  document.getElementById("viewer-label").textContent = nome;
  document.getElementById("viewer-label").style.display = "block";

  const w = wrap.clientWidth || 800, h = wrap.clientHeight || 500;
  threeScene = new THREE.Scene();
  threeScene.background = new THREE.Color(0x160A08);
  threeCamera = new THREE.PerspectiveCamera(45, w/h, 0.01, 1000);
  threeRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  threeRenderer.setSize(w, h);
  threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  threeScene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const dir = new THREE.DirectionalLight(0xffffff, 1); dir.position.set(5,10,5); threeScene.add(dir);
  const fill = new THREE.DirectionalLight(0xffddcc, 0.3); fill.position.set(-5,2,-5); threeScene.add(fill);
  threeScene.add(new THREE.GridHelper(20, 30, 0x2A1008, 0x1A0805));
  carregarModelo(url, ext, token);
  canvas.addEventListener("mousedown", e => { isDragging=true; prevMouseX=e.clientX; prevMouseY=e.clientY; });
  window.addEventListener("mouseup", () => isDragging=false);
  window.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("wheel", onWheel, { passive: true });
  camTheta=0.5; camPhi=0.8; camRadius=10; updateCamera();
  function animate() { threeAnimId=requestAnimationFrame(animate); if(autoRotate){camTheta+=0.005;updateCamera();} threeRenderer.render(threeScene,threeCamera); }
  animate();
}

function carregarModelo(url, ext, token) {
  const s = document.createElement("script");
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (ext === "obj") {
    s.src = "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/OBJLoader.js";
    s.onload = () => {
      const loader = new THREE.OBJLoader();
      loader.load(url, obj => { centralizarModelo(obj); threeScene.add(obj); obj.traverse(c => { if(c.isMesh){meshes.push(c);c.material=new THREE.MeshPhongMaterial({color:0xB84030});} }); }, undefined, e => console.error(e), headers);
    };
  } else {
    s.src = "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js";
    s.onload = () => {
      const loader = new THREE.GLTFLoader();
      loader.load(url, gltf => { centralizarModelo(gltf.scene); threeScene.add(gltf.scene); gltf.scene.traverse(c => { if(c.isMesh)meshes.push(c); }); }, undefined, e => console.error(e));
    };
  }
  document.head.appendChild(s);
}

function centralizarModelo(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const scale = 6 / Math.max(size.x, size.y, size.z);
  obj.scale.setScalar(scale);
  obj.position.sub(center.multiplyScalar(scale));
  obj.position.y += size.y * scale / 2;
  camRadius=10; updateCamera();
}

function onMouseMove(e) {
  if(!isDragging) return;
  camTheta -= (e.clientX-prevMouseX)*0.008;
  camPhi -= (e.clientY-prevMouseY)*0.008;
  camPhi = Math.max(0.05, Math.min(Math.PI/2-0.02, camPhi));
  prevMouseX=e.clientX; prevMouseY=e.clientY;
  updateCamera();
}
function onWheel(e) { camRadius=Math.max(2,Math.min(30,camRadius+e.deltaY*0.02)); updateCamera(); }
function updateCamera() {
  if(!threeCamera) return;
  threeCamera.position.set(camRadius*Math.sin(camPhi)*Math.sin(camTheta), camRadius*Math.cos(camPhi), camRadius*Math.sin(camPhi)*Math.cos(camTheta));
  threeCamera.lookAt(0,1,0);
}
window.resetCamera = () => { camTheta=0.5; camPhi=0.8; camRadius=10; updateCamera(); };
window.toggleWireframe = () => { wireMode=!wireMode; meshes.forEach(m=>{if(m.material)m.material.wireframe=wireMode;}); };
window.toggleAutoRotate = () => { autoRotate=!autoRotate; document.getElementById("btn-rotate").textContent=autoRotate?"⏸":"▶"; };

function destruirViewer() {
  cancelAnimationFrame(threeAnimId);
  window.removeEventListener("mousemove", onMouseMove);
  if(threeRenderer){threeRenderer.dispose();threeRenderer=null;}
  threeScene=null; threeCamera=null; meshes=[];
  const canvas=document.getElementById("three-canvas"); if(canvas)canvas.style.display="none";
  const empty=document.getElementById("viewer-empty"); if(empty)empty.style.display="flex";
  const ctrl=document.getElementById("viewer-controls"); if(ctrl)ctrl.style.display="none";
  const lbl=document.getElementById("viewer-label"); if(lbl)lbl.style.display="none";
}
