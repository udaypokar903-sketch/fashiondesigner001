/* ======================================================
   FASHION DESIGNER — Tailor Shop Manager
   Offline-first using IndexedDB, synced live via Firestore.
====================================================== */

const DB_NAME = 'tagged_db';
const DB_VERSION = 1;
let db;

// ---- Firebase config (from your Firebase console) ----
const firebaseConfig = {
  apiKey: "AIzaSyA8r13y9gDK8tLQTp3I5QhqNBo5M60MYZY",
  authDomain: "fashion-designer-shop.firebaseapp.com",
  projectId: "fashion-designer-shop",
  storageBucket: "fashion-designer-shop.firebasestorage.app",
  messagingSenderId: "325491815826",
  appId: "1:325491815826:web:2edde3c69ce9601f0d7d4b"
};

let fbApp, fbDb;
let currentShopId = null;
let unsubCustomers = null;
let unsubOrders = null;
let unsubMeta = null;
let unsubWorkers = null;
let isApplyingRemote = false; // guard to avoid sync feedback loops

const MEASURE_FIELDS = {
  shirt: ['Chest','Waist','Shoulder','Sleeve length','Neck','Shirt length','Cuff','Neck Shape'],
  kurta: ['Chest','Waist','Shoulder','Sleeve length','Kurta length','Neck','Neck Shape'],
  'pant / trouser': ['Waist','Hip','Inseam','Outseam','Thigh','Bottom'],
  suit: ['Chest','Waist','Shoulder','Sleeve length','Jacket length','Hip','Neck Shape'],
  blouse: ['Bust','Waist','Shoulder','Sleeve length','Blouse length','Armhole','Neck Shape'],
  lehenga: ['Waist','Hip','Lehenga length','Blouse bust','Blouse length','Neck Shape'],
  sherwani: ['Chest','Waist','Shoulder','Sleeve length','Sherwani length','Neck','Neck Shape'],
  dress: ['Bust','Waist','Hip','Shoulder','Dress length','Sleeve length','Neck Shape'],
  other: ['Chest/Bust','Waist','Hip','Shoulder','Length','Sleeve length']
};
const DEFAULT_MEASURE_SET = ['Chest/Bust','Waist','Hip','Shoulder','Sleeve length','Length','Neck','Inseam'];

// Fields that take a word/style choice instead of a number, with their preset options
const WORD_MEASURE_FIELDS = {
  'Neck Shape': ['Round neck','V-neck','Boat neck','Collar','Mandarin collar','Sweetheart','Halter','Square neck','Off-shoulder'],
  'Collar Style': ['Classic collar','Mandarin collar','Spread collar','Button-down','Band collar','No collar'],
  'Fit Type': ['Slim fit','Regular fit','Loose fit','Relaxed fit']
};

// Fields that accept multiple comma-separated numbers in one box (e.g. "5,8,11,23")
const COMMA_LIST_FIELDS = ['Sleeve', 'Sleeve Round'];

const DEFAULT_GARMENT_TYPES = ['Shirt','Kurta','Pant / Trouser','Suit','Blouse','Lehenga','Sherwani','Dress','Other'];

const COLOR_PALETTE = [
  { name:'White', hex:'#FFFFFF' },
  { name:'Black', hex:'#1A1816' },
  { name:'Navy', hex:'#1F2D4A' },
  { name:'Maroon', hex:'#7A1F2B' },
  { name:'Red', hex:'#C23B30' },
  { name:'Mustard', hex:'#D9A23B' },
  { name:'Beige', hex:'#D8C7A8' },
  { name:'Olive', hex:'#6B7D5C' },
  { name:'Royal Blue', hex:'#2C4FA3' },
  { name:'Grey', hex:'#8B8479' },
  { name:'Pink', hex:'#D98C9E' },
  { name:'Mint', hex:'#A9C9B8' }
];

let state = {
  view: 'home',
  customers: [],
  orders: [],
  shopName: 'Your Tailor Shop',
  garmentTypes: [...DEFAULT_GARMENT_TYPES],
  wordMeasureFields: JSON.parse(JSON.stringify(WORD_MEASURE_FIELDS)),
  garmentFieldTemplates: {}, // garmentName (lowercase) -> [field names], overrides MEASURE_FIELDS once customized
  workers: [],
  currentCustomerId: null,
  currentOrderId: null,
  orderFilter: 'all',
  measureUnit: 'in',
  measureFields: [],
  measureValues: {},
  measureCustomerId: null,
  measureByGarment: {},
  newOrderColor: null,
  newOrderPhoto: null,
  currentUserRole: 'owner',   // 'owner' or 'worker'
  currentWorkerId: null,
  currentWorkerName: null
};

/* ---------------- IndexedDB setup ---------------- */
function openDB(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e)=>{
      const d = e.target.result;
      if(!d.objectStoreNames.contains('customers')){
        d.createObjectStore('customers', { keyPath:'id' });
      }
      if(!d.objectStoreNames.contains('orders')){
        d.createObjectStore('orders', { keyPath:'id' });
      }
      if(!d.objectStoreNames.contains('meta')){
        d.createObjectStore('meta', { keyPath:'key' });
      }
    };
    req.onsuccess = (e)=> resolve(e.target.result);
    req.onerror = (e)=> reject(e);
  });
}

function dbGetAll(storeName){
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = ()=> resolve(req.result || []);
    req.onerror = (e)=> reject(e);
  });
}
function dbPut(storeName, value){
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = ()=> resolve();
    tx.onerror = (e)=> reject(e);
  });
}
function dbDelete(storeName, key){
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = ()=> resolve();
    tx.onerror = (e)=> reject(e);
  });
}
function dbClear(storeName){
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = ()=> resolve();
    tx.onerror = (e)=> reject(e);
  });
}

function uid(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}
function todayStr(){
  return new Date().toISOString().slice(0,10);
}
function formatDate(d){
  if(!d) return '—';
  const dt = new Date(d+'T00:00:00');
  return dt.toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
}
function isOverdue(dueDate, status){
  if(status === 'delivered') return false;
  if(!dueDate) return false;
  return new Date(dueDate+'T23:59:59') < new Date();
}
function daysFromNow(d){
  const diff = (new Date(d+'T00:00:00') - new Date(todayStr()+'T00:00:00')) / 86400000;
  return Math.round(diff);
}

/* ---------------- Init ---------------- */
async function init(){
  db = await openDB();

  // Init Firebase
  fbApp = firebase.initializeApp(firebaseConfig);
  fbDb = firebase.firestore();

  bindLoginEvents();
  bindEvents();
  updateConnectionPill();
  registerSW();

  // If this device already logged into a shop before, skip straight to the app
  const remembered = localStorage.getItem('fd_shopId');
  const rememberedName = localStorage.getItem('fd_shopName');
  const rememberedWorkerId = localStorage.getItem('fd_workerId');
  const rememberedWorkerName = localStorage.getItem('fd_workerName');
  if(remembered){
    const role = rememberedWorkerId ? 'worker' : 'owner';
    await enterShop(remembered, rememberedName || 'Your Tailor Shop', role, rememberedWorkerId, rememberedWorkerName);
  } else {
    document.getElementById('loginPinInput').focus();
  }
}

async function enterShop(shopId, shopName, role, workerId, workerName){
  currentShopId = shopId;
  state.shopName = shopName;
  state.currentUserRole = role || 'owner';
  state.currentWorkerId = workerId || null;
  state.currentWorkerName = workerName || null;

  const [customers, orders, metaRows] = await Promise.all([
    dbGetAll('customers'), dbGetAll('orders'), dbGetAll('meta')
  ]);
  state.customers = customers;
  state.orders = orders;
  const garmentMeta = metaRows.find(m=>m.key==='garmentTypes');
  if(garmentMeta && Array.isArray(garmentMeta.value) && garmentMeta.value.length){
    state.garmentTypes = garmentMeta.value;
  }
  const wordFieldsMeta = metaRows.find(m=>m.key==='wordMeasureFields');
  if(wordFieldsMeta && wordFieldsMeta.value && Object.keys(wordFieldsMeta.value).length){
    state.wordMeasureFields = wordFieldsMeta.value;
  }
  const fieldTemplatesMeta = metaRows.find(m=>m.key==='garmentFieldTemplates');
  if(fieldTemplatesMeta && fieldTemplatesMeta.value){
    state.garmentFieldTemplates = fieldTemplatesMeta.value;
  }

  document.getElementById('shopName').textContent = state.shopName;
  document.getElementById('shopNameInput').value = state.shopName;
  document.getElementById('newOrderDate').value = todayStr();
  populateGarmentSelect();
  applyRoleUI();

  renderAll();

  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('fabAdd').classList.remove('hidden');
  document.querySelector('.bottom-nav').classList.remove('hidden');

  startCloudSync(shopId);

}

function applyRoleUI(){
  const isWorker = state.currentUserRole === 'worker';
  document.getElementById('shopName').textContent = isWorker
    ? `${state.shopName} · ${state.currentWorkerName}`
    : state.shopName;
  // Workers don't manage shop settings, workers, or wipe/import data
  document.querySelectorAll('.owner-only').forEach(el=>{
    el.style.display = isWorker ? 'none' : '';
  });
  document.querySelectorAll('.worker-only').forEach(el=>{
    el.style.display = isWorker ? '' : 'none';
  });
}

/* ---------------- PIN hashing (simple, local-only obfuscation) ---------------- */
async function hashPin(pin){
  const enc = new TextEncoder().encode('fd-salt-' + pin);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

function slugifyShopName(name){
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'') || 'shop';
}

/* ---------------- Login screen logic ---------------- */
function bindLoginEvents(){
  document.getElementById('loginPinInput').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter') attemptLogin();
  });
  document.getElementById('newShopPinConfirm').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter') createShop();
  });
  document.getElementById('workerLoginPin').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter') attemptWorkerLogin();
  });
}

function switchLoginRole(role){
  document.querySelectorAll('#loginRoleSeg button').forEach(b=>b.classList.toggle('active', b.dataset.role===role));
  document.getElementById('ownerLoginFields').style.display = role === 'owner' ? 'block' : 'none';
  document.getElementById('workerLoginFields').style.display = role === 'worker' ? 'block' : 'none';
  document.getElementById('loginError').textContent = '';
  document.getElementById('loginStatus').textContent = '';
}

function showCreateShop(){
  document.getElementById('createShopFields').style.display = 'block';
}

async function attemptLogin(){
  const pin = document.getElementById('loginPinInput').value.trim();
  const errEl = document.getElementById('loginError');
  const statusEl = document.getElementById('loginStatus');
  errEl.textContent = '';

  if(!pin){ errEl.textContent = 'Enter your shop PIN'; return; }
  if(!navigator.onLine){
    errEl.textContent = 'First login on a new device needs internet — try again once connected.';
    return;
  }

  statusEl.textContent = 'Checking…';
  try{
    const pinHash = await hashPin(pin);
    const shopSnap = await fbDb.collection('shops').where('pinHash','==',pinHash).limit(1).get();
    if(!shopSnap.empty){
      const doc = shopSnap.docs[0];
      const shopId = doc.id;
      const shopName = doc.data().shopName || 'Your Tailor Shop';

      localStorage.setItem('fd_shopId', shopId);
      localStorage.setItem('fd_shopName', shopName);
      localStorage.removeItem('fd_workerId');
      localStorage.removeItem('fd_workerName');
      statusEl.textContent = '';
      await enterShop(shopId, shopName, 'owner', null, null);
      return;
    }

    statusEl.textContent = '';
    errEl.textContent = 'Incorrect PIN. Try again or set up a new shop.';
  }catch(err){
    statusEl.textContent = '';
    errEl.textContent = 'Could not connect. Check your internet and try again.';
  }
}

async function attemptWorkerLogin(){
  const name = document.getElementById('workerLoginName').value.trim();
  const pin = document.getElementById('workerLoginPin').value.trim();
  const errEl = document.getElementById('loginError');
  const statusEl = document.getElementById('loginStatus');
  errEl.textContent = '';

  if(!name){ errEl.textContent = 'Enter your name'; return; }
  if(!pin){ errEl.textContent = 'Enter your PIN'; return; }
  if(!navigator.onLine){
    errEl.textContent = 'First login on a new device needs internet — try again once connected.';
    return;
  }

  statusEl.textContent = 'Checking…';
  try{
    const pinHash = await hashPin(pin);
    const workerSnap = await fbDb.collectionGroup('workers').where('pinHash','==',pinHash).get();

    if(workerSnap.empty){
      statusEl.textContent = '';
      errEl.textContent = 'Incorrect name or PIN. Ask your shop owner to check.';
      return;
    }

    // Match by name too (case-insensitive) in case the PIN alone isn't unique across shops
    const match = workerSnap.docs.find(d => (d.data().name||'').trim().toLowerCase() === name.toLowerCase())
      || workerSnap.docs[0];

    const workerData = match.data();
    if(workerData.active === false){
      statusEl.textContent = '';
      errEl.textContent = 'This worker account has been removed. Contact your shop owner.';
      return;
    }

    const shopId = match.ref.parent.parent.id;
    const shopDoc = await fbDb.collection('shops').doc(shopId).get();
    const shopName = (shopDoc.exists && shopDoc.data().shopName) || 'Your Tailor Shop';

    localStorage.setItem('fd_shopId', shopId);
    localStorage.setItem('fd_shopName', shopName);
    localStorage.setItem('fd_workerId', match.id);
    localStorage.setItem('fd_workerName', workerData.name || name);
    statusEl.textContent = '';
    await enterShop(shopId, shopName, 'worker', match.id, workerData.name || name);
  }catch(err){
    statusEl.textContent = '';
    errEl.textContent = 'Could not connect. Check your internet and try again.';
  }
}

async function createShop(){
  const name = document.getElementById('newShopName').value.trim();
  const pin = document.getElementById('newShopPin').value.trim();
  const pinConfirm = document.getElementById('newShopPinConfirm').value.trim();
  const errEl = document.getElementById('loginError');
  const statusEl = document.getElementById('loginStatus');
  errEl.textContent = '';

  if(!name){ errEl.textContent = 'Enter a shop name'; return; }
  if(pin.length < 4){ errEl.textContent = 'PIN must be at least 4 digits'; return; }
  if(pin !== pinConfirm){ errEl.textContent = 'PINs do not match'; return; }
  if(!navigator.onLine){ errEl.textContent = 'Setting up a new shop needs internet the first time'; return; }

  statusEl.textContent = 'Setting up your shop…';
  try{
    const pinHash = await hashPin(pin);
    const shopRef = fbDb.collection('shops').doc();
    await shopRef.set({
      shopName: name,
      pinHash,
      garmentTypes: DEFAULT_GARMENT_TYPES,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    localStorage.setItem('fd_shopId', shopRef.id);
    localStorage.setItem('fd_shopName', name);
    localStorage.removeItem('fd_workerId');
    localStorage.removeItem('fd_workerName');
    statusEl.textContent = '';
    await dbPut('meta', { key:'shopName', value:name });
    await enterShop(shopRef.id, name, 'owner', null, null);
  }catch(err){
    statusEl.textContent = '';
    errEl.textContent = 'Could not create shop. Check your internet and try again.';
  }
}

function logoutShop(){
  if(!confirm('Log out on this device? Your data stays safe in the cloud.')) return;
  if(unsubCustomers) unsubCustomers();
  if(unsubOrders) unsubOrders();
  if(unsubMeta) unsubMeta();
  if(unsubWorkers) unsubWorkers();
  localStorage.removeItem('fd_shopId');
  localStorage.removeItem('fd_shopName');
  localStorage.removeItem('fd_workerId');
  localStorage.removeItem('fd_workerName');
  location.reload();
}

/* ---------------- Cloud sync engine ---------------- */
function shopCollection(name){
  return fbDb.collection('shops').doc(currentShopId).collection(name);
}

function startCloudSync(shopId){
  // Push anything currently local up to the cloud first (covers first-time migration)
  pushLocalDataToCloud();

  // Listen for customers
  unsubCustomers = shopCollection('customers').onSnapshot(async (snap)=>{
    isApplyingRemote = true;
    for(const change of snap.docChanges()){
      const data = { ...change.doc.data(), id: change.doc.id };
      if(change.type === 'removed'){
        await dbDelete('customers', change.doc.id);
        state.customers = state.customers.filter(c=>c.id !== change.doc.id);
      } else {
        await dbPut('customers', data);
        const idx = state.customers.findIndex(c=>c.id===data.id);
        if(idx>=0) state.customers[idx] = data; else state.customers.push(data);
      }
    }
    isApplyingRemote = false;
    renderAll();
    if(state.view==='customer-detail' && state.currentCustomerId) openCustomerDetail(state.currentCustomerId);
  }, (err)=>{ console.warn('customer sync error', err); });

  // Listen for orders
  unsubOrders = shopCollection('orders').onSnapshot(async (snap)=>{
    isApplyingRemote = true;
    for(const change of snap.docChanges()){
      const data = { ...change.doc.data(), id: change.doc.id };
      if(change.type === 'removed'){
        await dbDelete('orders', change.doc.id);
        state.orders = state.orders.filter(o=>o.id !== change.doc.id);
      } else {
        await dbPut('orders', data);
        const idx = state.orders.findIndex(o=>o.id===data.id);
        if(idx>=0) state.orders[idx] = data; else state.orders.push(data);
      }
    }
    isApplyingRemote = false;
    renderAll();
    if(state.view==='order-detail' && state.currentOrderId) openOrderDetail(state.currentOrderId);
  }, (err)=>{ console.warn('order sync error', err); });

  // Listen for shop-level meta (shop name, garment types, word measure fields)
  unsubMeta = fbDb.collection('shops').doc(shopId).onSnapshot(async (doc)=>{
    if(!doc.exists) return;
    const data = doc.data();
    if(data.shopName && data.shopName !== state.shopName){
      state.shopName = data.shopName;
      document.getElementById('shopName').textContent = data.shopName;
      document.getElementById('shopNameInput').value = data.shopName;
      localStorage.setItem('fd_shopName', data.shopName);
    }
    if(Array.isArray(data.garmentTypes) && data.garmentTypes.length){
      state.garmentTypes = data.garmentTypes;
      populateGarmentSelect();
    }
    if(data.wordMeasureFields && Object.keys(data.wordMeasureFields).length){
      state.wordMeasureFields = data.wordMeasureFields;
      await dbPut('meta', { key:'wordMeasureFields', value:data.wordMeasureFields });
      if(state.view === 'more') renderWordFieldsManager();
    }
    if(data.garmentFieldTemplates){
      state.garmentFieldTemplates = data.garmentFieldTemplates;
      await dbPut('meta', { key:'garmentFieldTemplates', value:data.garmentFieldTemplates });
    }
  }, (err)=>{ console.warn('meta sync error', err); });

  // Listen for workers list (owner manages, worker logins check against this)
  unsubWorkers = shopCollection('workers').onSnapshot((snap)=>{
    state.workers = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    if(state.view==='more') renderWorkersList();
    populateAssignSelect();
  }, (err)=>{ console.warn('workers sync error', err); });
}

async function pushLocalDataToCloud(){
  try{
    const batchOps = [];
    for(const c of state.customers) batchOps.push(shopCollection('customers').doc(c.id).set(c, { merge:true }));
    for(const o of state.orders) batchOps.push(shopCollection('orders').doc(o.id).set(o, { merge:true }));
    await Promise.all(batchOps);
  }catch(err){
    console.warn('Initial cloud push failed (will retry via normal saves):', err);
  }
}

async function syncToCloud(collectionName, docData){
  if(!currentShopId || isApplyingRemote) return;
  try{
    await shopCollection(collectionName).doc(docData.id).set(docData, { merge:true });
  }catch(err){
    console.warn('Cloud sync deferred (offline?) for', collectionName, err);
  }
}

async function syncDeleteFromCloud(collectionName, id){
  if(!currentShopId) return;
  try{
    await shopCollection(collectionName).doc(id).delete();
  }catch(err){
    console.warn('Cloud delete deferred (offline?) for', collectionName, err);
  }
}


/* ---------------- Navigation ---------------- */
function goTo(viewName){
  if(state.currentUserRole === 'worker' && (viewName === 'customers' || viewName === 'customer-detail')){
    viewName = 'home';
  }
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+viewName).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  const navBtn = document.querySelector(`.nav-btn[data-view="${viewName}"]`);
  if(navBtn) navBtn.classList.add('active');
  state.view = viewName;
  const fab = document.getElementById('fabAdd');
  fab.style.display = (viewName==='home' || viewName==='orders') ? 'flex' : (viewName==='customers' ? 'flex' : 'none');
  if(viewName === 'more' && state.currentUserRole !== 'worker'){
    renderWorkersList();
    populateIncomeMonthSelect();
    renderIncomeReport();
  }
  if(viewName === 'more' && state.currentUserRole === 'worker'){
    populateWorkerEarningsMonthSelect();
    renderWorkerEarnings();
  }
  window.scrollTo(0,0);
}

function goBackFromOrder(){
  if(state.currentCustomerId){ openCustomerDetail(state.currentCustomerId); }
  else { goTo('orders'); }
}

/* ---------------- Rendering ---------------- */
function renderAll(){
  renderStats();
  renderHomeOrders();
  renderOrdersList();
  renderCustomersList();
  populateCustomerSelect();
  populateAssignSelect();
  if(state.currentUserRole !== 'worker'){
    renderWorkersList();
    populateIncomeMonthSelect();
    renderIncomeReport();
  }
  document.getElementById('moreTotalOrders').textContent = visibleOrders().length;
  document.getElementById('moreTotalCustomers').textContent = state.customers.length;
  updateBackupReminder();
}

function visibleOrders(){
  if(state.currentUserRole === 'worker' && state.currentWorkerId){
    return state.orders.filter(o=>o.assignedTo === state.currentWorkerId);
  }
  return state.orders;
}

function renderStats(){
  const orders = visibleOrders();
  const active = orders.filter(o=>o.status!=='delivered').length;
  const dueSoon = orders.filter(o=>{
    if(o.status==='delivered' || !o.dueDate) return false;
    const days = daysFromNow(o.dueDate);
    return days <= 7;
  }).length;
  document.getElementById('statActive').textContent = active;
  document.getElementById('statDue').textContent = dueSoon;
  document.getElementById('statCustomers').textContent = state.customers.length;
}

function customerById(id){ return state.customers.find(c=>c.id===id); }

function statusLabel(s){
  if(s === 'progress') s = 'pending'; // legacy orders saved before Stitching was removed
  return { pending:'Pending', ready:'Ready', delivered:'Delivered' }[s] || s;
}

function ticketHTML(order){
  const cust = customerById(order.customerId);
  const overdue = isOverdue(order.dueDate, order.status);
  const colorDot = order.color ? `<span class="color-chip"><span class="dot-swatch" style="background:${order.color.hex};"></span>${escapeHTML(order.color.name)}</span> · ` : '';
  return `
    <div class="ticket" onclick="openOrderDetail('${order.id}')">
      <div class="ticket-top">
        <div>
          <div class="ticket-name">${cust ? escapeHTML(cust.name) : 'Unknown customer'}</div>
          <div class="ticket-meta">${colorDot}${escapeHTML(order.garment)} · Qty ${order.qty || 1}</div>
        </div>
        <span class="status-tag ${order.status}">${statusLabel(order.status)}</span>
      </div>
      <div class="ticket-bottom">
        <span class="ticket-due ${overdue?'overdue':''}">${overdue?'Overdue · ':'Due '}${formatDate(order.dueDate)}</span>
        <span class="ticket-price">₹${(order.price||0).toLocaleString('en-IN')}</span>
      </div>
    </div>`;
}

function emptyStateHTML(label, hint){
  return `<div class="empty-state">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 2h6l1 4H8l1-4zM5 6h14l1 15H4L5 6z"/></svg>
    <p>${label}</p><p class="hint">${hint}</p>
  </div>`;
}

function renderHomeOrders(){
  const q = (document.getElementById('homeSearch').value || '').toLowerCase().trim();
  let orders = [...visibleOrders()].sort((a,b)=> (b.createdAt||0) - (a.createdAt||0));
  if(q){
    orders = orders.filter(o=>{
      const cust = customerById(o.customerId);
      return (cust && cust.name.toLowerCase().includes(q)) || o.garment.toLowerCase().includes(q);
    });
  }
  orders = orders.slice(0, 8);
  const el = document.getElementById('homeOrderList');
  el.innerHTML = orders.length ? orders.map(ticketHTML).join('') : emptyStateHTML('No orders yet', 'Tap the + button to create your first order');
}

function renderOrdersList(){
  const q = (document.getElementById('orderSearch').value || '').toLowerCase().trim();
  let orders = [...visibleOrders()];
  if(state.orderFilter !== 'all'){
    orders = orders.filter(o=>o.status === state.orderFilter);
  }
  if(q){
    orders = orders.filter(o=>{
      const cust = customerById(o.customerId);
      return (cust && cust.name.toLowerCase().includes(q)) ||
        (cust && (cust.phone||'').includes(q)) ||
        o.garment.toLowerCase().includes(q);
    });
  }
  orders.sort((a,b)=> (a.dueDate||'9999').localeCompare(b.dueDate||'9999'));
  const el = document.getElementById('ordersList');
  el.innerHTML = orders.length ? orders.map(ticketHTML).join('') : emptyStateHTML('No orders here', 'Try a different filter or search');
}


function renderCustomersList(){
  const q = (document.getElementById('customerSearch').value || '').toLowerCase().trim();
  let customers = [...state.customers].sort((a,b)=> a.name.localeCompare(b.name));
  if(q) customers = customers.filter(c=> c.name.toLowerCase().includes(q) || (c.phone||'').includes(q));
  const el = document.getElementById('customersList');
  if(!customers.length){
    el.innerHTML = emptyStateHTML('No customers yet', 'Tap the + button to add your first customer');
    return;
  }
  el.innerHTML = customers.map(c=>{
    const orderCount = state.orders.filter(o=>o.customerId===c.id).length;
    const initial = c.name.trim().charAt(0).toUpperCase();
    return `
      <div class="customer-row" onclick="openCustomerDetail('${c.id}')">
        <div class="avatar">${initial}</div>
        <div class="customer-info">
          <div class="customer-name">${escapeHTML(c.name)}</div>
          <div class="customer-sub">${c.phone ? escapeHTML(c.phone)+' · ' : ''}${orderCount} order${orderCount===1?'':'s'}</div>
        </div>
        <svg class="chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
      </div>`;
  }).join('');
}

function populateCustomerSelect(){
  // Kept for compatibility with renderAll() calls; actual filtering happens live in renderCustomerPickerDropdown
  const input = document.getElementById('customerPickerInput');
  const hiddenId = document.getElementById('newOrderCustomer').value;
  if(hiddenId){
    const c = customerById(hiddenId);
    if(c && input && !input.matches(':focus')){
      input.value = c.name + (c.phone ? ' · ' + c.phone : '');
    }
  }
}

function renderCustomerPickerDropdown(query){
  const dropdown = document.getElementById('customerPickerDropdown');
  const q = (query || '').toLowerCase().trim();
  const sorted = [...state.customers].sort((a,b)=>a.name.localeCompare(b.name));
  const filtered = q
    ? sorted.filter(c => c.name.toLowerCase().includes(q) || (c.phone||'').includes(q))
    : sorted;

  if(!filtered.length){
    dropdown.innerHTML = `<div class="searchable-dropdown-empty">No customers found</div>`;
  } else {
    dropdown.innerHTML = filtered.slice(0, 30).map(c=>`
      <div class="searchable-dropdown-item" onclick="pickCustomerFromDropdown('${c.id}')">
        <span>${escapeHTML(c.name)}</span>
        ${c.phone ? `<span class="sub">${escapeHTML(c.phone)}</span>` : ''}
      </div>`).join('');
  }
  dropdown.classList.add('open');
}

function pickCustomerFromDropdown(customerId){
  const c = customerById(customerId);
  if(!c) return;
  document.getElementById('newOrderCustomer').value = customerId;
  document.getElementById('customerPickerInput').value = c.name + (c.phone ? ' · ' + c.phone : '');
  document.getElementById('customerPickerDropdown').classList.remove('open');
}

function clearCustomerPicker(){
  document.getElementById('newOrderCustomer').value = '';
  document.getElementById('customerPickerInput').value = '';
}

/* ---------------- Garment type management ---------------- */
function populateGarmentSelect(){
  const sel = document.getElementById('newOrderGarment');
  const current = sel.value;
  sel.innerHTML = state.garmentTypes.map(g=>`<option>${escapeHTML(g)}</option>`).join('');
  if(state.garmentTypes.includes(current)) sel.value = current;
  renderGarmentTypeList();
}

function renderGarmentTypeList(){
  const el = document.getElementById('garmentTypeList');
  if(!el) return;
  el.innerHTML = state.garmentTypes.map((g, i)=>`
    <div class="garment-row">
      <span>${escapeHTML(g)}</span>
      <button onclick="removeGarmentType(${i})">Remove</button>
    </div>`).join('');
}

async function addGarmentType(){
  const input = document.getElementById('newGarmentInput');
  const name = input.value.trim();
  if(!name){ showToast('Type a garment name first'); return; }
  if(state.garmentTypes.some(g=>g.toLowerCase()===name.toLowerCase())){
    showToast('Already in the list');
    return;
  }
  state.garmentTypes.push(name);
  await dbPut('meta', { key:'garmentTypes', value:state.garmentTypes });
  syncShopMeta({ garmentTypes: state.garmentTypes });
  input.value = '';
  renderGarmentTypeList();
  showToast('Garment type added');
}

async function removeGarmentType(index){
  if(state.garmentTypes.length <= 1){ showToast('Keep at least one garment type'); return; }
  state.garmentTypes.splice(index, 1);
  await dbPut('meta', { key:'garmentTypes', value:state.garmentTypes });
  syncShopMeta({ garmentTypes: state.garmentTypes });
  renderGarmentTypeList();
}

function syncShopMeta(fields){
  if(!currentShopId || isApplyingRemote) return;
  fbDb.collection('shops').doc(currentShopId).set(fields, { merge:true }).catch(err=>{
    console.warn('Shop meta sync deferred (offline?)', err);
  });
}

async function persistWordMeasureFields(){
  await dbPut('meta', { key:'wordMeasureFields', value:state.wordMeasureFields });
  syncShopMeta({ wordMeasureFields: state.wordMeasureFields });
}

async function persistGarmentFieldTemplate(garment){
  const key = garment.toLowerCase();
  state.garmentFieldTemplates[key] = [...state.measureFields];
  await dbPut('meta', { key:'garmentFieldTemplates', value:state.garmentFieldTemplates });
  syncShopMeta({ garmentFieldTemplates: state.garmentFieldTemplates });
}

/* ---------------- Style field management (Neck Shape, etc.) ---------------- */
function openWordFieldManager(){
  renderWordFieldsManager();
  openSheet('wordFieldManageOverlay');
}

function renderWordFieldsManager(){
  const el = document.getElementById('wordFieldsList');
  if(!el) return;
  const fields = Object.keys(state.wordMeasureFields);
  if(!fields.length){
    el.innerHTML = `<p style="font-size:12.5px; color:var(--muted); padding:0 4px 6px;">No style fields yet</p>`;
    return;
  }
  el.innerHTML = fields.map(f=>{
    const count = (state.wordMeasureFields[f] || []).length;
    return `
    <div class="garment-row" style="cursor:pointer;" onclick="openWordChoiceManager('${escapeHTML(f)}')">
      <span>${escapeHTML(f)} <span style="color:var(--muted); font-weight:400; font-size:12px;">· ${count} choice${count===1?'':'s'}</span></span>
      <button onclick="event.stopPropagation(); removeWordField('${escapeHTML(f)}')">Remove</button>
    </div>`;
  }).join('');
}

async function addWordField(){
  const input = document.getElementById('newWordFieldInput');
  const name = input.value.trim();
  if(!name){ showToast('Type a field name first'); return; }
  if(state.wordMeasureFields[name]){ showToast('That field already exists'); return; }
  state.wordMeasureFields[name] = [];
  await persistWordMeasureFields();
  input.value = '';
  renderWordFieldsManager();
  showToast('Style field added — now add choices');
  openWordChoiceManager(name);
}

async function removeWordField(name){
  if(!confirm(`Remove "${name}"? This won't delete measurements already saved with this field, but it will stop appearing as a choice list for new ones.`)) return;
  delete state.wordMeasureFields[name];
  await persistWordMeasureFields();
  renderWordFieldsManager();
  showToast('Style field removed');
}

let activeWordField = null;

function openWordChoiceManager(fieldName){
  activeWordField = fieldName;
  document.getElementById('wordChoiceFieldTitle').textContent = fieldName + ' choices';
  renderWordChoicesList();
  closeSheet('wordFieldManageOverlay');
  openSheet('wordChoiceManageOverlay');
}

function renderWordChoicesList(){
  const el = document.getElementById('wordChoicesList');
  const choices = state.wordMeasureFields[activeWordField] || [];
  if(!choices.length){
    el.innerHTML = `<p style="font-size:12.5px; color:var(--muted); padding:0 4px 6px;">No choices yet — add some below</p>`;
    return;
  }
  el.innerHTML = choices.map((c,i)=>`
    <div class="garment-row">
      <span>${escapeHTML(c)}</span>
      <button onclick="removeWordChoice(${i})">Remove</button>
    </div>`).join('');
}

async function addWordChoice(){
  const input = document.getElementById('newWordChoiceInput');
  const value = input.value.trim();
  if(!value){ showToast('Type a choice first'); return; }
  if(!state.wordMeasureFields[activeWordField]) state.wordMeasureFields[activeWordField] = [];
  if(state.wordMeasureFields[activeWordField].some(c=>c.toLowerCase()===value.toLowerCase())){
    showToast('That choice already exists');
    return;
  }
  state.wordMeasureFields[activeWordField].push(value);
  await persistWordMeasureFields();
  input.value = '';
  renderWordChoicesList();
}

async function removeWordChoice(index){
  state.wordMeasureFields[activeWordField].splice(index, 1);
  await persistWordMeasureFields();
  renderWordChoicesList();
}

/* ---------------- Worker management (owner only) ---------------- */
function renderWorkersList(){
  const el = document.getElementById('workersList');
  if(!el) return;
  if(!state.workers.length){
    el.innerHTML = `<p style="font-size:12.5px; color:var(--muted); padding:0 4px 6px;">No workers added yet</p>`;
    return;
  }
  el.innerHTML = state.workers.map(w=>{
    const assignedCount = state.orders.filter(o=>o.assignedTo===w.id).length;
    return `
    <div class="garment-row">
      <span>${escapeHTML(w.name)} <span style="color:var(--muted); font-weight:400; font-size:12px;">· ${assignedCount} order${assignedCount===1?'':'s'}</span></span>
      <button onclick="removeWorker('${w.id}')">Remove</button>
    </div>`;
  }).join('');
}

/* ---------------- Monthly income report (owner only) ---------------- */
function monthKey(dateStr){
  if(!dateStr) return null;
  return dateStr.slice(0,7); // 'YYYY-MM'
}
function monthLabel(key){
  const [y,m] = key.split('-');
  const d = new Date(parseInt(y), parseInt(m)-1, 1);
  return d.toLocaleDateString('en-IN', { month:'long', year:'numeric' });
}

function populateIncomeMonthSelect(){
  const sel = document.getElementById('incomeMonthSelect');
  if(!sel) return;
  const keys = new Set(state.orders.map(o=>monthKey(o.orderDate)).filter(Boolean));
  keys.add(monthKey(todayStr()));
  const sorted = [...keys].sort().reverse();
  const current = sel.value;
  sel.innerHTML = sorted.map(k=>`<option value="${k}">${monthLabel(k)}</option>`).join('');
  if(sorted.includes(current)) sel.value = current;
}

function renderIncomeReport(){
  const sel = document.getElementById('incomeMonthSelect');
  const summaryCard = document.getElementById('incomeSummaryCard');
  const workerCard = document.getElementById('incomeWorkerCard');
  if(!sel || !summaryCard || !workerCard) return;
  const selectedMonth = sel.value;

  const monthOrders = state.orders.filter(o=>monthKey(o.orderDate) === selectedMonth);
  const totalIncome = monthOrders.reduce((sum,o)=>sum + (o.price||0), 0);
  const totalAdvance = monthOrders.reduce((sum,o)=>sum + (o.advance||0), 0);
  const totalPending = totalIncome - totalAdvance;
  const totalPaidToWorkers = monthOrders.reduce((sum,o)=>sum + (o.workerPayment||0), 0);
  const netIncome = totalIncome - totalPaidToWorkers;

  summaryCard.innerHTML = `
    <div class="info-row"><span class="k">Orders this month</span><span class="v">${monthOrders.length}</span></div>
    <div class="info-row"><span class="k">Total billed</span><span class="v">₹${totalIncome.toLocaleString('en-IN')}</span></div>
    <div class="info-row"><span class="k">Collected (advance + paid)</span><span class="v">₹${totalAdvance.toLocaleString('en-IN')}</span></div>
    <div class="info-row"><span class="k">Pending from customers</span><span class="v">₹${totalPending.toLocaleString('en-IN')}</span></div>
    <div class="info-row"><span class="k">Paid to workers</span><span class="v">₹${totalPaidToWorkers.toLocaleString('en-IN')}</span></div>
    <div class="info-row"><span class="k" style="font-weight:700; color:var(--ink);">Net income</span><span class="v" style="font-weight:700;">₹${netIncome.toLocaleString('en-IN')}</span></div>
  `;

  if(!state.workers.length){
    workerCard.innerHTML = `<div class="info-row"><span class="k" style="color:var(--muted);">No workers added yet</span></div>`;
  } else {
    workerCard.innerHTML = state.workers.map(w=>{
      const workerOrders = monthOrders.filter(o=>o.assignedTo===w.id);
      const totalPaid = workerOrders.reduce((sum,o)=>sum + (o.workerPayment||0), 0);
      return `<div class="info-row"><span class="k">${escapeHTML(w.name)} · ${workerOrders.length} order${workerOrders.length===1?'':'s'}</span><span class="v">₹${totalPaid.toLocaleString('en-IN')}</span></div>`;
    }).join('');
  }
}

function populateWorkerEarningsMonthSelect(){
  const sel = document.getElementById('workerEarningsMonthSelect');
  if(!sel) return;
  const myOrders = state.orders.filter(o=>o.assignedTo === state.currentWorkerId);
  const keys = new Set(myOrders.map(o=>monthKey(o.orderDate)).filter(Boolean));
  keys.add(monthKey(todayStr()));
  const sorted = [...keys].sort().reverse();
  const current = sel.value;
  sel.innerHTML = sorted.map(k=>`<option value="${k}">${monthLabel(k)}</option>`).join('');
  if(sorted.includes(current)) sel.value = current;
}

function renderWorkerEarnings(){
  const sel = document.getElementById('workerEarningsMonthSelect');
  const card = document.getElementById('workerEarningsCard');
  if(!sel || !card) return;
  if(!sel.options.length) populateWorkerEarningsMonthSelect();
  const selectedMonth = sel.value;

  const myOrders = state.orders.filter(o=>o.assignedTo === state.currentWorkerId && monthKey(o.orderDate) === selectedMonth);
  const totalPaid = myOrders.reduce((sum,o)=>sum + (o.workerPayment||0), 0);

  card.innerHTML = `
    <div class="info-row"><span class="k">Your orders this month</span><span class="v">${myOrders.length}</span></div>
    <div class="info-row"><span class="k" style="font-weight:700; color:var(--ink);">Your total payment</span><span class="v" style="font-weight:700;">₹${totalPaid.toLocaleString('en-IN')}</span></div>
  `;
}

function csvEscape(val){
  const s = String(val ?? '');
  if(s.includes(',') || s.includes('"') || s.includes('\n')){
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function downloadIncomeCSV(){
  const sel = document.getElementById('incomeMonthSelect');
  if(!sel) return;
  const selectedMonth = sel.value;
  const monthOrders = state.orders.filter(o=>monthKey(o.orderDate) === selectedMonth)
    .sort((a,b)=>(a.orderDate||'').localeCompare(b.orderDate||''));

  const rows = [];
  rows.push(['Income report', monthLabel(selectedMonth)]);
  rows.push([]);
  rows.push(['Order date','Customer','Phone','Garment','Qty','Price','Advance','Balance','Status','Assigned worker','Worker payment']);

  monthOrders.forEach(o=>{
    const cust = customerById(o.customerId);
    const worker = o.assignedTo ? state.workers.find(w=>w.id===o.assignedTo) : null;
    rows.push([
      formatDate(o.orderDate),
      cust ? cust.name : 'Unknown',
      cust && cust.phone ? cust.phone : '',
      o.garment,
      o.qty || 1,
      o.price || 0,
      o.advance || 0,
      (o.price||0) - (o.advance||0),
      statusLabel(o.status),
      worker ? worker.name : 'Unassigned',
      o.workerPayment || 0
    ]);
  });

  const totalIncome = monthOrders.reduce((sum,o)=>sum + (o.price||0), 0);
  const totalAdvance = monthOrders.reduce((sum,o)=>sum + (o.advance||0), 0);
  const totalPaidToWorkers = monthOrders.reduce((sum,o)=>sum + (o.workerPayment||0), 0);
  const netIncome = totalIncome - totalPaidToWorkers;

  rows.push([]);
  rows.push(['Total orders', monthOrders.length]);
  rows.push(['Total billed', totalIncome]);
  rows.push(['Collected (advance + paid)', totalAdvance]);
  rows.push(['Pending from customers', totalIncome - totalAdvance]);
  rows.push(['Paid to workers', totalPaidToWorkers]);
  rows.push(['Net income', netIncome]);

  const csvContent = rows.map(row => row.map(csvEscape).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csvContent], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `income-${selectedMonth}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Income report downloaded');
}

async function addWorker(){
  const nameInput = document.getElementById('newWorkerName');
  const pinInput = document.getElementById('newWorkerPin');
  const name = nameInput.value.trim();
  const pin = pinInput.value.trim();

  if(!name){ showToast('Enter a worker name'); return; }
  if(pin.length < 4){ showToast('PIN must be at least 4 digits'); return; }
  if(!navigator.onLine){ showToast('Adding a worker needs internet'); return; }

  try{
    const pinHash = await hashPin(pin);
    // Make sure this PIN isn't already used by another worker or the owner PIN
    const existingWorker = state.workers.find(w=>w.pinHash===pinHash);
    if(existingWorker){ showToast('That PIN is already used by another worker'); return; }

    await shopCollection('workers').add({
      name,
      pinHash,
      active: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    nameInput.value = '';
    pinInput.value = '';
    showToast('Worker added');
  }catch(err){
    showToast('Could not add worker — check your internet');
  }
}

async function removeWorker(workerId){
  const worker = state.workers.find(w=>w.id===workerId);
  const assignedCount = state.orders.filter(o=>o.assignedTo===workerId).length;
  const msg = assignedCount
    ? `Remove ${worker ? worker.name : 'this worker'}? Their ${assignedCount} assigned order${assignedCount===1?'':'s'} will become unassigned. They will no longer be able to log in.`
    : `Remove ${worker ? worker.name : 'this worker'}? They will no longer be able to log in.`;
  if(!confirm(msg)) return;

  try{
    await shopCollection('workers').doc(workerId).delete();
    // Unassign any orders that referenced this worker
    const affected = state.orders.filter(o=>o.assignedTo===workerId);
    for(const o of affected){
      o.assignedTo = null;
      await dbPut('orders', o);
      syncToCloud('orders', o);
    }
    renderAll();
    showToast('Worker removed');
  }catch(err){
    showToast('Could not remove worker — check your internet');
  }
}

function populateAssignSelect(){
  const sel = document.getElementById('orderAssignSelect');
  if(!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Unassigned</option>' +
    state.workers.map(w=>`<option value="${w.id}">${escapeHTML(w.name)}</option>`).join('');
  if(current) sel.value = current;
}

/* ---------------- Garment colour picker ---------------- */
function renderColorSwatches(){
  const el = document.getElementById('newOrderColorSwatches');
  el.innerHTML = COLOR_PALETTE.map(c=>{
    const selected = state.newOrderColor && state.newOrderColor.hex.toLowerCase() === c.hex.toLowerCase();
    return `<div class="color-swatch ${selected?'selected':''}" style="background:${c.hex};" title="${escapeHTML(c.name)}" onclick="selectOrderColor('${c.hex}','${escapeHTML(c.name)}')"></div>`;
  }).join('');
}

function selectOrderColor(hex, name){
  state.newOrderColor = { hex, name };
  document.getElementById('newOrderColorPicker').value = hex;
  document.getElementById('newOrderColorName').value = name;
  renderColorSwatches();
}

function bindColorCustomInputs(){
  const picker = document.getElementById('newOrderColorPicker');
  const nameInput = document.getElementById('newOrderColorName');
  picker.addEventListener('input', ()=>{
    state.newOrderColor = { hex: picker.value, name: nameInput.value.trim() || 'Custom' };
    renderColorSwatches();
  });
  nameInput.addEventListener('input', ()=>{
    state.newOrderColor = { hex: picker.value, name: nameInput.value.trim() || 'Custom' };
    renderColorSwatches();
  });
}

function resetOrderColorPicker(){
  state.newOrderColor = null;
  document.getElementById('newOrderColorPicker').value = '#8B8479';
  document.getElementById('newOrderColorName').value = '';
  renderColorSwatches();
}

/* ---------------- Garment photo upload ---------------- */
function bindPhotoInput(){
  document.getElementById('newOrderPhotoInput').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    if(!file.type.startsWith('image/')){ showToast('Please choose an image file'); return; }
    const reader = new FileReader();
    reader.onload = (evt)=>{
      compressImage(evt.target.result, (dataUrl)=>{
        state.newOrderPhoto = dataUrl;
        renderPhotoPreview();
      });
    };
    reader.readAsDataURL(file);
  });
}

// Downscale to keep IndexedDB light — long side capped at 900px, JPEG quality 0.72
function compressImage(dataUrl, callback){
  const img = new Image();
  img.onload = ()=>{
    const maxSide = 900;
    let { width, height } = img;
    if(width > height && width > maxSide){ height = Math.round(height * (maxSide/width)); width = maxSide; }
    else if(height > maxSide){ width = Math.round(width * (maxSide/height)); height = maxSide; }
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    callback(canvas.toDataURL('image/jpeg', 0.72));
  };
  img.onerror = ()=> callback(dataUrl);
  img.src = dataUrl;
}

function renderPhotoPreview(){
  const el = document.getElementById('newOrderPhotoPreview');
  if(state.newOrderPhoto){
    el.className = 'photo-preview-filled';
    el.innerHTML = `
      <img src="${state.newOrderPhoto}" alt="Garment photo">
      <button class="photo-remove-btn" onclick="removeOrderPhoto(event)">✕</button>`;
  } else {
    el.className = 'photo-preview-empty';
    el.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h3l2-3h6l2 3h3v13H4V7z"/><circle cx="12" cy="13" r="3.5"/></svg>
      <span>Tap to add a photo</span>`;
  }
}

function removeOrderPhoto(e){
  e.stopPropagation();
  state.newOrderPhoto = null;
  renderPhotoPreview();
}

function resetOrderPhoto(){
  state.newOrderPhoto = null;
  document.getElementById('newOrderPhotoInput').value = '';
  renderPhotoPreview();
}

function escapeHTML(str){
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/* ---------------- Customer detail ---------------- */
let currentCustomerId = null;

let custDetailActiveGarment = null;

function openCustomerDetail(id){
  currentCustomerId = id;
  state.currentCustomerId = id;
  const c = customerById(id);
  if(!c) return;
  document.getElementById('custDetailName').textContent = c.name;
  document.getElementById('custDetailInfo').innerHTML = `
    <div class="info-row"><span class="k">Phone</span><span class="v">${c.phone ? escapeHTML(c.phone) : '—'}</span></div>
    <div class="info-row"><span class="k">Address</span><span class="v">${c.address ? escapeHTML(c.address) : '—'}</span></div>
    <div class="info-row"><span class="k">Customer since</span><span class="v">${formatDate(c.createdAt ? new Date(c.createdAt).toISOString().slice(0,10) : null)}</span></div>
  `;

  const byGarment = getMeasurementsByGarment(c);
  const garmentKeys = Object.keys(byGarment);
  const tabsEl = document.getElementById('custMeasureTabs');

  if(!garmentKeys.length){
    tabsEl.innerHTML = '';
    document.getElementById('custDetailMeasurements').innerHTML =
      `<div class="info-row"><span class="k" style="color:var(--muted);">No measurements recorded yet</span></div>`;
  } else {
    if(!custDetailActiveGarment || !garmentKeys.includes(custDetailActiveGarment)){
      custDetailActiveGarment = garmentKeys[0];
    }
    tabsEl.innerHTML = garmentKeys.map(g=>
      `<button class="${g===custDetailActiveGarment?'active':''}" onclick="switchCustDetailGarment('${escapeHTML(g)}')">${escapeHTML(g)}</button>`
    ).join('');
    renderCustDetailMeasurementGrid(byGarment[custDetailActiveGarment]);
  }

  document.getElementById('custEditMeasureBtn').onclick = ()=> openMeasureSheet(id, custDetailActiveGarment);
  document.getElementById('custPrintMeasureBtn').onclick = ()=> openSlipGarmentPicker(id);

  const orders = visibleOrders().filter(o=>o.customerId===id).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const ordersEl = document.getElementById('custDetailOrders');
  ordersEl.innerHTML = orders.length ? orders.map(ticketHTML).join('') : emptyStateHTML('No orders yet', 'This customer has no order history');

  goTo('customer-detail');
}

function switchCustDetailGarment(garment){
  custDetailActiveGarment = garment;
  openCustomerDetail(state.currentCustomerId);
}

function formatMeasureValue(key, value, unit){
  if(getWordOptionsFor(key)) return escapeHTML(value);
  return `${escapeHTML(value)} ${unit||'in'}`;
}

function renderCustDetailMeasurementGrid(m){
  const grid = document.getElementById('custDetailMeasurements');
  if(m && m.values && Object.keys(m.values).some(k=>m.values[k])){
    grid.innerHTML = Object.entries(m.values)
      .filter(([k,v])=>v)
      .map(([k,v])=>`<div class="info-row"><span class="k">${escapeHTML(k)}</span><span class="v">${formatMeasureValue(k,v,m.unit)}</span></div>`)
      .join('') + (m.notes ? `<div class="info-row"><span class="k">Notes</span><span class="v" style="text-align:right; max-width:65%;">${escapeHTML(m.notes)}</span></div>` : '');
  } else {
    grid.innerHTML = `<div class="info-row"><span class="k" style="color:var(--muted);">No measurements recorded for this garment yet</span></div>`;
  }
}

function openEditCustomerSheet(customerId){
  const c = customerById(customerId);
  if(!c) return;
  document.getElementById('editCustName').value = c.name || '';
  document.getElementById('editCustPhone').value = c.phone || '';
  document.getElementById('editCustAddress').value = c.address || '';
  document.getElementById('editCustomerOverlay').dataset.customerId = customerId;
  openSheet('editCustomerOverlay');
}

async function saveEditedCustomer(){
  const customerId = document.getElementById('editCustomerOverlay').dataset.customerId;
  const c = customerById(customerId);
  if(!c) return;
  const name = document.getElementById('editCustName').value.trim();
  if(!name){ showToast('Name cannot be empty'); return; }
  c.name = name;
  c.phone = document.getElementById('editCustPhone').value.trim();
  c.address = document.getElementById('editCustAddress').value.trim();
  await dbPut('customers', c);
  syncToCloud('customers', c);
  closeSheet('editCustomerOverlay');
  renderAll();
  openCustomerDetail(customerId);
  showToast('Customer updated');
}

async function deleteCurrentCustomer(){
  const customerId = document.getElementById('editCustomerOverlay').dataset.customerId;
  const orderCount = state.orders.filter(o=>o.customerId===customerId).length;
  const msg = orderCount
    ? `Delete this customer and their ${orderCount} order${orderCount===1?'':'s'}? This cannot be undone.`
    : 'Delete this customer? This cannot be undone.';
  if(!confirm(msg)) return;

  const ordersToDelete = state.orders.filter(o=>o.customerId===customerId);
  for(const o of ordersToDelete){
    await dbDelete('orders', o.id);
    syncDeleteFromCloud('orders', o.id);
  }
  await dbDelete('customers', customerId);
  syncDeleteFromCloud('customers', customerId);

  state.orders = state.orders.filter(o=>o.customerId!==customerId);
  state.customers = state.customers.filter(c=>c.id!==customerId);

  closeSheet('editCustomerOverlay');
  renderAll();
  showToast('Customer deleted');
  goTo('customers');
}

/* ---------------- Migrate old single measurement set to per-garment format ---------------- */
function getMeasurementsByGarment(c){
  if(c.measurementsByGarment) return c.measurementsByGarment;
  // Migrate legacy single `measurements` object into the new per-garment shape
  if(c.measurements && c.measurements.values && Object.keys(c.measurements.values).length){
    // Guess the garment type from their most recent order, else fall back to 'General'
    const customerOrders = state.orders.filter(o=>o.customerId===c.id).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    const garmentGuess = (customerOrders[0] && customerOrders[0].garment) || 'General';
    return { [garmentGuess]: c.measurements };
  }
  return {};
}

let lastViewedMeasureGarment = null;
let gridLoadedForGarment = null; // the garment whose data is CURRENTLY sitting in the on-screen grid

function openMeasureSheet(customerId, presetGarment){
  const c = customerById(customerId);
  if(!c) return;
  const byGarment = getMeasurementsByGarment(c);
  state.measureCustomerId = customerId;
  state.measureByGarment = JSON.parse(JSON.stringify(byGarment)); // working copy

  // Build garment dropdown: shop garment types + 'General' + any already-saved custom keys
  const optionSet = new Set([...state.garmentTypes, ...Object.keys(byGarment), 'General']);
  const garmentSelect = document.getElementById('measureGarmentSelect');
  garmentSelect.innerHTML = [...optionSet].map(g=>`<option value="${escapeHTML(g)}">${escapeHTML(g)}</option>`).join('')
    + `<option value="__other__">Other (type your own)…</option>`;
  document.getElementById('measureGarmentCustomInput').style.display = 'none';
  document.getElementById('measureGarmentCustomInput').value = '';

  // Decide which garment to show: explicit preset > last viewed (if still valid) > first option
  let initialGarment;
  if(presetGarment && optionSet.has(presetGarment)){
    initialGarment = presetGarment;
  } else if(lastViewedMeasureGarment && optionSet.has(lastViewedMeasureGarment)){
    initialGarment = lastViewedMeasureGarment;
  } else {
    initialGarment = [...optionSet][0];
  }
  garmentSelect.value = initialGarment;
  lastViewedMeasureGarment = initialGarment;
  gridLoadedForGarment = initialGarment;

  loadMeasureFieldsForGarment(initialGarment);
  document.getElementById('measureSheetOverlay').dataset.customerId = customerId;
  openSheet('measureSheetOverlay');
}

function onMeasureGarmentChange(){
  // Save current grid into the working copy BEFORE switching — using the garment that's
  // actually loaded right now, not whatever the dropdown has already changed to.
  commitGridToWorkingCopy(gridLoadedForGarment);
  const select = document.getElementById('measureGarmentSelect');
  const customInput = document.getElementById('measureGarmentCustomInput');

  if(select.value === '__other__'){
    customInput.style.display = 'block';
    customInput.value = '';
    customInput.focus();
    return; // wait for them to type and confirm — grid/template stay on the previous garment until then
  }

  customInput.style.display = 'none';
  const garment = select.value;
  lastViewedMeasureGarment = garment;
  gridLoadedForGarment = garment;
  loadMeasureFieldsForGarment(garment);
}

function onMeasureGarmentCustomConfirm(){
  const customInput = document.getElementById('measureGarmentCustomInput');
  const name = customInput.value.trim();
  if(!name){ return; }

  const select = document.getElementById('measureGarmentSelect');
  // Add the new garment as a real option just above "Other", and select it
  const otherOption = select.querySelector('option[value="__other__"]');
  const newOption = document.createElement('option');
  newOption.value = name;
  newOption.textContent = name;
  select.insertBefore(newOption, otherOption);
  select.value = name;
  customInput.style.display = 'none';

  lastViewedMeasureGarment = name;
  gridLoadedForGarment = name;
  loadMeasureFieldsForGarment(name);

  // Also add it to the shop's garment type list so it's available for new orders too
  if(!state.garmentTypes.some(g=>g.toLowerCase()===name.toLowerCase())){
    state.garmentTypes.push(name);
    dbPut('meta', { key:'garmentTypes', value:state.garmentTypes });
    syncShopMeta({ garmentTypes: state.garmentTypes });
    populateGarmentSelect();
  }
}

function getFieldTemplateFor(garment){
  const key = garment.toLowerCase();
  if(state.garmentFieldTemplates[key] && state.garmentFieldTemplates[key].length){
    return [...state.garmentFieldTemplates[key]];
  }
  if(MEASURE_FIELDS[key] && MEASURE_FIELDS[key].length){
    return [...MEASURE_FIELDS[key]];
  }
  return [...DEFAULT_MEASURE_SET];
}

function loadMeasureFieldsForGarment(garment){
  const existing = state.measureByGarment[garment];
  const unit = (existing && existing.unit) || 'in';
  state.measureUnit = unit;
  document.querySelectorAll('#measureUnitSeg button').forEach(b=>b.classList.toggle('active', b.dataset.unit===unit));

  // Start from the shop's saved template for this garment (preserves custom names/order)
  const fields = getFieldTemplateFor(garment);
  // Include any extra fields this specific customer already has saved but aren't in the template
  if(existing && existing.values){
    Object.keys(existing.values).forEach(f=>{
      if(!fields.includes(f)) fields.push(f);
    });
  }

  state.measureFields = fields;
  state.measureValues = { ...(existing && existing.values || {}) };
  renderMeasureGrid();
  document.getElementById('measureNotes').value = (existing && existing.notes) || '';
}

function captureMeasureGridValues(){
  document.querySelectorAll('#measureGrid .measure-field-wrap').forEach(wrap=>{
    const select = wrap.querySelector('select[data-role="word-select"]');
    const customInput = wrap.querySelector('input[data-role="word-custom"]');
    const commaInput = wrap.querySelector('input[data-role="comma-list"]');
    const plainInput = wrap.querySelector('input:not([data-role])');

    if(select){
      const field = select.dataset.field;
      if(select.value === '__custom__'){
        state.measureValues[field] = customInput ? customInput.value : '';
      } else {
        state.measureValues[field] = select.value;
      }
    } else if(commaInput){
      state.measureValues[commaInput.dataset.field] = commaInput.value;
    } else if(plainInput){
      state.measureValues[plainInput.dataset.field] = plainInput.value;
    }
  });
}

function commitGridToWorkingCopy(garmentOverride){
  captureMeasureGridValues();
  const garment = garmentOverride || document.getElementById('measureGarmentSelect').value;
  const values = {};
  state.measureFields.forEach(f=>{
    if(state.measureValues[f]) values[f] = state.measureValues[f];
  });
  state.measureByGarment[garment] = {
    unit: state.measureUnit,
    values,
    notes: document.getElementById('measureNotes').value.trim()
  };
}

function getWordOptionsFor(fieldName){
  if(state.wordMeasureFields[fieldName]) return state.wordMeasureFields[fieldName];
  const match = Object.keys(state.wordMeasureFields).find(k=>k.toLowerCase()===fieldName.toLowerCase());
  return match ? state.wordMeasureFields[match] : null;
}

function isCommaListField(fieldName){
  return COMMA_LIST_FIELDS.some(f=>f.toLowerCase()===fieldName.toLowerCase());
}

function renderMeasureGrid(){
  // capture any values currently typed/selected before re-rendering
  captureMeasureGridValues();

  const grid = document.getElementById('measureGrid');
  grid.innerHTML = state.measureFields.map((f, i)=>{
    const wordOptions = getWordOptionsFor(f);
    const currentVal = state.measureValues[f] || '';

    let control;
    if(wordOptions){
      const isCustomVal = currentVal && !wordOptions.includes(currentVal);
      control = `
        <select data-field="${escapeHTML(f)}" data-role="word-select" onchange="handleWordSelectChange(this)">
          <option value="">— Select —</option>
          ${wordOptions.map(opt=>`<option value="${escapeHTML(opt)}" ${currentVal===opt?'selected':''}>${escapeHTML(opt)}</option>`).join('')}
          <option value="__custom__" ${isCustomVal?'selected':''}>Other (type your own)…</option>
        </select>
        <input type="text" data-field="${escapeHTML(f)}" data-role="word-custom"
          value="${isCustomVal?escapeHTML(currentVal):''}" placeholder="Type your own…"
          style="margin-top:8px; ${isCustomVal?'':'display:none;'}">`;
    } else if(isCommaListField(f)){
      control = `<input type="text" inputmode="decimal" data-field="${escapeHTML(f)}" data-role="comma-list" value="${escapeHTML(currentVal)}" placeholder="e.g. 5,8,11,23">`;
    } else {
      control = `<input type="number" step="0.1" data-field="${escapeHTML(f)}" value="${escapeHTML(currentVal)}" placeholder="0.0">`;
    }

    const isFirst = i === 0;
    const isLast = i === state.measureFields.length - 1;
    return `
    <div class="measure-field-wrap">
      <div class="measure-field-head">
        <div class="field-reorder">
          <button type="button" onclick="moveMeasureField(${i}, -1)" ${isFirst?'disabled':''} aria-label="Move up">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
          </button>
          <button type="button" onclick="moveMeasureField(${i}, 1)" ${isLast?'disabled':''} aria-label="Move down">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </button>
        </div>
        <div class="field-remove" onclick="removeMeasureField(${i})">✕</div>
      </div>
      <div class="field">
        <label>${escapeHTML(f)}${isCommaListField(f)?' <span style="color:var(--muted); font-weight:400; font-size:11px;">(comma list)</span>':''}</label>
        ${control}
      </div>
    </div>`;
  }).join('');
}

function moveMeasureField(index, direction){
  captureMeasureGridValues();
  const newIndex = index + direction;
  if(newIndex < 0 || newIndex >= state.measureFields.length) return;
  const fields = state.measureFields;
  [fields[index], fields[newIndex]] = [fields[newIndex], fields[index]];
  renderMeasureGrid();
  persistGarmentFieldTemplate(gridLoadedForGarment);
}

function handleWordSelectChange(selectEl){
  const wrap = selectEl.closest('.field');
  const customInput = wrap.querySelector('input[data-role="word-custom"]');
  if(selectEl.value === '__custom__'){
    customInput.style.display = 'block';
    customInput.focus();
  } else {
    customInput.style.display = 'none';
    customInput.value = '';
  }
}

function removeMeasureField(index){
  const field = state.measureFields[index];
  captureMeasureGridValues();
  state.measureFields.splice(index, 1);
  delete state.measureValues[field];
  renderMeasureGrid();
  persistGarmentFieldTemplate(gridLoadedForGarment);
}

function addMeasureField(){
  const input = document.getElementById('newMeasureFieldInput');
  const name = input.value.trim();
  if(!name){ showToast('Type a field name first'); return; }
  if(state.measureFields.some(f=>f.toLowerCase()===name.toLowerCase())){
    showToast('That field already exists');
    return;
  }
  captureMeasureGridValues();
  state.measureFields.push(name);
  input.value = '';
  renderMeasureGrid();
  persistGarmentFieldTemplate(gridLoadedForGarment);
}

async function saveMeasurements(){
  const customerId = document.getElementById('measureSheetOverlay').dataset.customerId;
  const c = customerById(customerId);
  if(!c) return;
  commitGridToWorkingCopy(gridLoadedForGarment);

  c.measurementsByGarment = state.measureByGarment;
  delete c.measurements; // drop legacy field now that it's migrated
  await dbPut('customers', c);
  syncToCloud('customers', c);
  closeSheet('measureSheetOverlay');
  showToast('Measurements saved');
  if(state.view === 'order-detail' && state.currentOrderId){
    openOrderDetail(state.currentOrderId);
  } else {
    openCustomerDetail(customerId);
  }
}

/* ---------------- Order detail ---------------- */
function openOrderDetail(id){
  const order = state.orders.find(o=>o.id===id);
  if(!order) return;
  state.currentOrderId = id;
  const cust = customerById(order.customerId);

  document.getElementById('orderDetailTitle').textContent = order.garment;
  const colorRow = order.color
    ? `<div class="info-row"><span class="k">Colour</span><span class="v color-chip"><span class="dot-swatch" style="background:${order.color.hex};"></span>${escapeHTML(order.color.name)}</span></div>`
    : '';
  const assignedWorker = order.assignedTo ? state.workers.find(w=>w.id===order.assignedTo) : null;
  const assignedRow = (state.currentUserRole === 'worker')
    ? `<div class="info-row"><span class="k">Assigned to</span><span class="v">${assignedWorker ? escapeHTML(assignedWorker.name) : 'Unassigned'}</span></div>
       ${order.workerPayment ? `<div class="info-row"><span class="k">Your payment</span><span class="v">₹${order.workerPayment.toLocaleString('en-IN')}</span></div>` : ''}`
    : '';
  document.getElementById('orderDetailInfo').innerHTML = `
    <div class="info-row"><span class="k">Customer</span><span class="v">${cust ? escapeHTML(cust.name) : '—'}</span></div>
    <div class="info-row"><span class="k">Phone</span><span class="v">${cust && cust.phone ? escapeHTML(cust.phone) : '—'}</span></div>
    <div class="info-row"><span class="k">Quantity</span><span class="v">${order.qty || 1}</span></div>
    ${colorRow}
    ${assignedRow}
    <div class="info-row"><span class="k">Order date</span><span class="v">${formatDate(order.orderDate)}</span></div>
    <div class="info-row"><span class="k">Delivery date</span><span class="v">${formatDate(order.dueDate)}</span></div>
    <div class="info-row"><span class="k">Total price</span><span class="v">₹${(order.price||0).toLocaleString('en-IN')}</span></div>
    <div class="info-row"><span class="k">Advance paid</span><span class="v">₹${(order.advance||0).toLocaleString('en-IN')}</span></div>
    <div class="info-row"><span class="k">Balance due</span><span class="v">₹${((order.price||0)-(order.advance||0)).toLocaleString('en-IN')}</span></div>
  `;
  if(order.photo){
    document.getElementById('orderDetailPhotoWrap').innerHTML = `<img src="${order.photo}" class="order-photo-thumb" alt="Garment photo">`;
  } else {
    document.getElementById('orderDetailPhotoWrap').innerHTML = '';
  }

  // Show this order's garment-specific measurements, full list
  const measureEl = document.getElementById('orderDetailMeasurements');
  if(cust){
    const byGarment = getMeasurementsByGarment(cust);
    const m = byGarment[order.garment];
    if(m && m.values && Object.keys(m.values).some(k=>m.values[k])){
      measureEl.innerHTML = Object.entries(m.values)
        .filter(([k,v])=>v)
        .map(([k,v])=>`<div class="info-row"><span class="k">${escapeHTML(k)}</span><span class="v">${formatMeasureValue(k,v,m.unit)}</span></div>`)
        .join('') + (m.notes ? `<div class="info-row"><span class="k">Notes</span><span class="v" style="text-align:right; max-width:65%;">${escapeHTML(m.notes)}</span></div>` : '');
    } else {
      measureEl.innerHTML = `<div class="info-row"><span class="k" style="color:var(--muted);">No ${escapeHTML(order.garment)} measurements recorded for this customer yet</span></div>`;
    }
  } else {
    measureEl.innerHTML = `<div class="info-row"><span class="k" style="color:var(--muted);">No customer linked to this order</span></div>`;
  }
  const editMeasureBtn = document.getElementById('orderEditMeasureBtn');
  editMeasureBtn.onclick = ()=> { if(cust) openMeasureSheet(cust.id, order.garment); };
  editMeasureBtn.style.display = cust ? 'flex' : 'none';

  const printMeasureBtn = document.getElementById('orderPrintMeasureBtn');
  printMeasureBtn.onclick = ()=> { if(cust) printMeasurementSlip(cust.id, order.garment); };
  printMeasureBtn.style.display = cust ? 'flex' : 'none';

  document.querySelectorAll('#orderStatusSeg button').forEach(b=>b.classList.toggle('active', b.dataset.status===order.status));
  const assignSelect = document.getElementById('orderAssignSelect');
  if(assignSelect) assignSelect.value = order.assignedTo || '';

  const paymentField = document.getElementById('workerPaymentField');
  const paymentInput = document.getElementById('orderWorkerPayment');
  if(order.assignedTo){
    paymentField.style.display = 'block';
    paymentInput.value = order.workerPayment || '';
  } else {
    paymentField.style.display = 'none';
  }

  document.getElementById('orderNotesField').value = order.notes || '';
  goTo('order-detail');
}

async function updateOrderAssignment(){
  const order = state.orders.find(o=>o.id===state.currentOrderId);
  if(!order) return;
  const workerId = document.getElementById('orderAssignSelect').value;
  order.assignedTo = workerId || null;
  if(!workerId) order.workerPayment = 0;
  await dbPut('orders', order);
  syncToCloud('orders', order);
  renderAll();
  const paymentField = document.getElementById('workerPaymentField');
  const paymentInput = document.getElementById('orderWorkerPayment');
  if(workerId){
    paymentField.style.display = 'block';
    paymentInput.value = order.workerPayment || '';
  } else {
    paymentField.style.display = 'none';
  }
  const worker = state.workers.find(w=>w.id===workerId);
  showToast(worker ? `Assigned to ${worker.name}` : 'Order unassigned');
}

async function saveWorkerPayment(){
  const order = state.orders.find(o=>o.id===state.currentOrderId);
  if(!order) return;
  const amount = parseFloat(document.getElementById('orderWorkerPayment').value) || 0;
  order.workerPayment = amount;
  await dbPut('orders', order);
  syncToCloud('orders', order);
  showToast('Worker payment saved');
}

async function updateOrderStatus(status){
  const order = state.orders.find(o=>o.id===state.currentOrderId);
  if(!order) return;
  order.status = status;
  await dbPut('orders', order);
  syncToCloud('orders', order);
  document.querySelectorAll('#orderStatusSeg button').forEach(b=>b.classList.toggle('active', b.dataset.status===status));
  renderAll();
  showToast('Status updated to ' + statusLabel(status));
}

async function saveOrderNotes(){
  const order = state.orders.find(o=>o.id===state.currentOrderId);
  if(!order) return;
  order.notes = document.getElementById('orderNotesField').value.trim();
  await dbPut('orders', order);
  syncToCloud('orders', order);
}

async function deleteCurrentOrder(){
  if(!confirm('Delete this order? This cannot be undone.')) return;
  await dbDelete('orders', state.currentOrderId);
  syncDeleteFromCloud('orders', state.currentOrderId);
  state.orders = state.orders.filter(o=>o.id !== state.currentOrderId);
  renderAll();
  showToast('Order deleted');
  goBackFromOrder();
}

/* ---------------- Print receipt ---------------- */
/* ---------------- Shared print helper (opens a new window/tab — works reliably on mobile) ---------------- */
const RECEIPT_PRINT_CSS = `
  body{ font-family:'Inter',sans-serif; color:#111; margin:0; padding:0; }
  .receipt-header{ display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2.5px solid #111; padding-bottom:16px; margin-bottom:20px; }
  .receipt-shop{ font-family:'Fraunces',Georgia,serif; font-weight:700; font-size:28px; }
  .receipt-sub{ font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#555; margin-top:4px; }
  .receipt-header-right{ text-align:right; font-size:12.5px; color:#333; }
  .receipt-header-right .rc-label{ color:#777; font-size:10.5px; text-transform:uppercase; letter-spacing:0.05em; }
  .receipt-header-right div{ margin-bottom:4px; }
  .receipt-meta-block{ display:flex; justify-content:space-between; gap:40px; margin-bottom:26px; }
  .receipt-meta-col{ flex:1; }
  .receipt-meta-col .rc-label{ font-size:10.5px; text-transform:uppercase; letter-spacing:0.06em; color:#777; margin-bottom:5px; }
  .receipt-meta-col .rc-value{ font-size:14px; font-weight:600; }
  .receipt-meta-col .rc-sub{ font-size:12px; color:#555; margin-top:2px; }
  .receipt-items{ width:100%; border-collapse:collapse; margin-bottom:6px; }
  .receipt-items thead th{ text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:#555; padding:0 0 10px; border-bottom:1.5px solid #111; }
  .receipt-items th:nth-child(2), .receipt-items td:nth-child(2){ text-align:center; }
  .receipt-items th:last-child, .receipt-items td:last-child{ text-align:right; }
  .receipt-items td{ padding:16px 0; font-size:14px; border-bottom:1px solid #e5e5e5; vertical-align:top; }
  .receipt-item-photo{ width:64px; height:64px; object-fit:cover; border-radius:6px; border:1px solid #ddd; margin-top:8px; }
  .receipt-item-name{ font-weight:600; font-size:14.5px; }
  .receipt-item-sub{ font-size:12px; color:#666; margin-top:3px; }
  .receipt-totals-wrap{ display:flex; justify-content:flex-end; margin-top:18px; }
  .receipt-totals{ width:260px; border-collapse:collapse; }
  .receipt-totals td{ padding:6px 0; font-size:13.5px; }
  .receipt-totals td:last-child{ text-align:right; font-weight:600; }
  .receipt-balance td{ font-size:17px; font-weight:700; padding-top:12px; border-top:2px solid #111; }
  .receipt-footer{ text-align:center; font-size:12px; color:#777; margin-top:50px; padding-top:16px; border-top:1px solid #ddd; font-style:italic; }
`;

const SLIP_PRINT_CSS = `
  body{ font-family:'Inter',sans-serif; color:#111; margin:0; padding:0; }
  .slip-shop{ font-family:'Fraunces',Georgia,serif; font-weight:700; font-size:17px; text-align:center; }
  .slip-sub{ text-align:center; font-size:10.5px; letter-spacing:0.07em; text-transform:uppercase; color:#555; margin-top:2px; margin-bottom:10px; }
  .slip-divider{ border-top:1px dashed #999; margin:10px 0; }
  .slip-meta{ font-size:11.5px; margin-bottom:4px; }
  .slip-meta b{ color:#111; }
  .slip-garment{ font-size:13px; font-weight:700; margin:10px 0 6px; text-transform:uppercase; letter-spacing:0.03em; }
  .slip-row{ display:flex; justify-content:space-between; font-size:12px; padding:4px 0; border-bottom:1px dotted #ccc; }
  .slip-row span:first-child{ color:#555; }
  .slip-row span:last-child{ font-weight:600; }
  .slip-notes{ font-size:11px; color:#444; margin-top:8px; line-height:1.4; }
  .slip-footer{ text-align:center; font-size:10px; color:#888; margin-top:16px; font-style:italic; }
`;

function openPrintWindow(bodyHTML, pageRule, css, maxWidthMm, isSlip){
  const win = window.open('', '_blank');
  if(!win){
    showToast('Please allow pop-ups to print, then try again');
    return;
  }
  const widthStyle = isSlip ? `width:${maxWidthMm}mm; margin:0 auto;` : `width:100%; max-width:${maxWidthMm}mm; margin:0 auto;`;
  win.document.open();
  win.document.write(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHTML(state.shopName || 'Fashion Designer')}</title>
<style>
  ${pageRule}
  *{ box-sizing:border-box; }
  body{ padding:16px; }
  .print-wrap{ ${widthStyle} }
  ${css}
</style>
</head>
<body>
  <div class="print-wrap">${bodyHTML}</div>
  <script>
    window.onload = function(){
      setTimeout(function(){ window.print(); }, 250);
    };
  </script>
</body></html>`);
  win.document.close();
}

function printReceipt(orderId){
  const order = state.orders.find(o=>o.id===orderId);
  if(!order){ showToast('Open an order first'); return; }
  const cust = customerById(order.customerId);

  const colorText = order.color ? ' · ' + order.color.name : '';
  const photoHTML = order.photo ? `<img src="${order.photo}" class="receipt-item-photo" alt="">` : '';
  const total = order.price || 0;
  const advance = order.advance || 0;

  const itemsRow = `
    <tr>
      <td>
        <div class="receipt-item-name">${escapeHTML(order.garment)}${colorText}</div>
        ${order.notes ? `<div class="receipt-item-sub">${escapeHTML(order.notes)}</div>` : ''}
        ${photoHTML}
      </td>
      <td>${order.qty || 1}</td>
      <td>₹${total.toLocaleString('en-IN')}</td>
    </tr>`;

  const bodyHTML = `
    <div class="receipt-header">
      <div>
        <div class="receipt-shop">${escapeHTML(state.shopName || 'Your Tailor Shop')}</div>
        <div class="receipt-sub">Order Receipt</div>
      </div>
      <div class="receipt-header-right">
        <div><span class="rc-label">Receipt no. </span><b>#${order.id.slice(-6).toUpperCase()}</b></div>
        <div><span class="rc-label">Date </span><b>${formatDate(todayStr())}</b></div>
      </div>
    </div>
    <div class="receipt-meta-block">
      <div class="receipt-meta-col">
        <div class="rc-label">Billed to</div>
        <div class="rc-value">${cust ? escapeHTML(cust.name) : '—'}</div>
        <div class="rc-sub">${(cust && cust.phone) ? escapeHTML(cust.phone) : '—'}</div>
      </div>
      <div class="receipt-meta-col">
        <div class="rc-label">Delivery date</div>
        <div class="rc-value">${formatDate(order.dueDate)}</div>
      </div>
    </div>
    <table class="receipt-items">
      <thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead>
      <tbody>${itemsRow}</tbody>
    </table>
    <div class="receipt-totals-wrap">
      <table class="receipt-totals">
        <tr><td>Total</td><td>₹${total.toLocaleString('en-IN')}</td></tr>
        <tr><td>Advance paid</td><td>₹${advance.toLocaleString('en-IN')}</td></tr>
        <tr class="receipt-balance"><td>Balance due</td><td>₹${(total-advance).toLocaleString('en-IN')}</td></tr>
      </table>
    </div>
    <div class="receipt-footer">Thank you for your order</div>
  `;

  openPrintWindow(bodyHTML, '@page{ size:A4; margin:18mm 16mm; }', RECEIPT_PRINT_CSS, 190);
}

/* ---------------- Print measurement slip (compact card) ---------------- */
let slipPickerCustomerId = null;

function openSlipGarmentPicker(customerId){
  const c = customerById(customerId);
  if(!c) return;
  slipPickerCustomerId = customerId;

  const byGarment = getMeasurementsByGarment(c);
  const garmentKeys = Object.keys(byGarment);
  const listEl = document.getElementById('slipGarmentCheckboxList');

  if(!garmentKeys.length){
    listEl.innerHTML = `<p style="font-size:12.5px; color:var(--muted); padding:0 4px 10px;">No measurements recorded for this customer yet.</p>`;
  } else {
    listEl.innerHTML = garmentKeys.map((g,i)=>{
      const m = byGarment[g];
      const fieldCount = m && m.values ? Object.values(m.values).filter(Boolean).length : 0;
      return `
      <label class="check-row">
        <input type="checkbox" value="${escapeHTML(g)}" ${i===0?'checked':''}>
        <span>${escapeHTML(g)} <span class="sub">· ${fieldCount} field${fieldCount===1?'':'s'}</span></span>
      </label>`;
    }).join('');
  }

  openSheet('slipGarmentPickerOverlay');
}

function confirmPrintSelectedSlip(){
  const checked = [...document.querySelectorAll('#slipGarmentCheckboxList input[type="checkbox"]:checked')]
    .map(cb => cb.value);
  if(!checked.length){ showToast('Select at least one garment'); return; }
  closeSheet('slipGarmentPickerOverlay');
  printMeasurementSlip(slipPickerCustomerId, checked);
}

function printMeasurementSlip(customerId, onlyGarments){
  const c = customerById(customerId);
  if(!c){ showToast('Open a customer first'); return; }

  const byGarment = getMeasurementsByGarment(c);
  let garmentsToShow;
  if(Array.isArray(onlyGarments)) garmentsToShow = onlyGarments;
  else if(onlyGarments) garmentsToShow = [onlyGarments];
  else garmentsToShow = Object.keys(byGarment);

  let sectionsHTML;
  if(!garmentsToShow.length || garmentsToShow.every(g=>!byGarment[g])){
    sectionsHTML = `<div class="slip-meta" style="margin-top:10px; color:#888;">No measurements recorded yet</div>`;
  } else {
    sectionsHTML = garmentsToShow.map(g=>{
      const m = byGarment[g];
      if(!m || !m.values || !Object.keys(m.values).some(k=>m.values[k])){
        return `<div class="slip-garment">${escapeHTML(g)}</div><div class="slip-meta" style="color:#888;">No measurements recorded</div>`;
      }
      const rows = Object.entries(m.values)
        .filter(([k,v])=>v)
        .map(([k,v])=>`<div class="slip-row"><span>${escapeHTML(k)}</span><span>${formatMeasureValue(k,v,m.unit)}</span></div>`)
        .join('');
      const notes = m.notes ? `<div class="slip-notes">Notes: ${escapeHTML(m.notes)}</div>` : '';
      return `<div class="slip-garment">${escapeHTML(g)}</div>${rows}${notes}`;
    }).join('<div class="slip-divider"></div>');
  }

  const bodyHTML = `
    <div class="slip-shop">${escapeHTML(state.shopName || 'Your Tailor Shop')}</div>
    <div class="slip-sub">Measurement Slip</div>
    <div class="slip-divider"></div>
    <div class="slip-meta"><b>${escapeHTML(c.name)}</b></div>
    <div class="slip-meta">${c.phone ? escapeHTML(c.phone) : '—'}</div>
    <div class="slip-meta">Date: ${formatDate(todayStr())}</div>
    ${sectionsHTML}
    <div class="slip-footer">Fashion Designer</div>
  `;

  openPrintWindow(bodyHTML, '@page{ size:80mm auto; margin:5mm; }', SLIP_PRINT_CSS, 80, true);
}

/* ---------------- Create flows ---------------- */
function toggleNewCustomerFields(){
  const pickerInput = document.getElementById('customerPickerInput');
  const fields = document.getElementById('newCustomerFields');
  const showing = fields.style.display !== 'none';
  fields.style.display = showing ? 'none' : 'block';
  pickerInput.disabled = !showing;
  if(!showing) clearCustomerPicker();
  hideRepeatMatch();
}

let repeatMatchCustomerId = null;

function checkRepeatCustomer(){
  const phone = document.getElementById('newOrderCustomerPhone').value.trim();
  const matchEl = document.getElementById('repeatCustomerMatch');
  if(phone.length < 6){ hideRepeatMatch(); return; }

  const match = state.customers.find(c => c.phone && c.phone.trim() === phone);
  if(!match){ hideRepeatMatch(); return; }

  repeatMatchCustomerId = match.id;
  const orderCount = state.orders.filter(o=>o.customerId===match.id).length;
  const initial = match.name.trim().charAt(0).toUpperCase();
  matchEl.innerHTML = `
    <div class="repeat-match-card" onclick="useRepeatMatch()">
      <div class="avatar">${initial}</div>
      <div class="repeat-match-text">Found existing customer <b>${escapeHTML(match.name)}</b> · ${orderCount} order${orderCount===1?'':'s'} before</div>
      <div class="repeat-match-use">Use this</div>
    </div>`;
  matchEl.style.display = 'block';
}

function useRepeatMatch(){
  if(!repeatMatchCustomerId) return;
  // Switch back to the picker and select the matched customer
  document.getElementById('newCustomerFields').style.display = 'none';
  document.getElementById('customerPickerInput').disabled = false;
  pickCustomerFromDropdown(repeatMatchCustomerId);
  document.getElementById('newOrderCustomerName').value = '';
  document.getElementById('newOrderCustomerPhone').value = '';
  hideRepeatMatch();
  showToast('Using existing customer');
}

function hideRepeatMatch(){
  repeatMatchCustomerId = null;
  const matchEl = document.getElementById('repeatCustomerMatch');
  matchEl.style.display = 'none';
  matchEl.innerHTML = '';
}

async function saveNewOrder(){
  let customerId = document.getElementById('newOrderCustomer').value;
  const newName = document.getElementById('newOrderCustomerName').value.trim();

  if(!customerId && newName && repeatMatchCustomerId){
    customerId = repeatMatchCustomerId;
  } else if(!customerId && newName){
    const newCust = {
      id: uid(),
      name: newName,
      phone: document.getElementById('newOrderCustomerPhone').value.trim(),
      address: '',
      measurements: null,
      createdAt: Date.now()
    };
    await dbPut('customers', newCust);
    syncToCloud('customers', newCust);
    state.customers.push(newCust);
    customerId = newCust.id;
  }

  if(!customerId){
    showToast('Please select or add a customer');
    return;
  }

  const order = {
    id: uid(),
    customerId,
    garment: document.getElementById('newOrderGarment').value,
    qty: parseInt(document.getElementById('newOrderQty').value) || 1,
    orderDate: document.getElementById('newOrderDate').value || todayStr(),
    dueDate: document.getElementById('newOrderDue').value,
    price: parseFloat(document.getElementById('newOrderPrice').value) || 0,
    advance: parseFloat(document.getElementById('newOrderAdvance').value) || 0,
    notes: document.getElementById('newOrderNotes').value.trim(),
    color: state.newOrderColor,
    photo: state.newOrderPhoto,
    status: 'pending',
    createdAt: Date.now()
  };
  await dbPut('orders', order);
  syncToCloud('orders', order);
  state.orders.push(order);

  closeSheet('orderSheetOverlay');
  clearNewOrderForm();
  renderAll();
  showToast('Order created');
}

function clearNewOrderForm(){
  document.getElementById('newOrderCustomer').value = '';
  document.getElementById('customerPickerInput').value = '';
  document.getElementById('customerPickerInput').disabled = false;
  document.getElementById('newOrderCustomerName').value = '';
  document.getElementById('newOrderCustomerPhone').value = '';
  document.getElementById('newOrderGarment').value = 'Shirt';
  document.getElementById('newOrderQty').value = 1;
  document.getElementById('newOrderDate').value = todayStr();
  document.getElementById('newOrderDue').value = '';
  document.getElementById('newOrderPrice').value = '';
  document.getElementById('newOrderAdvance').value = '';
  document.getElementById('newOrderNotes').value = '';
  document.getElementById('newCustomerFields').style.display = 'none';
  resetOrderColorPicker();
  resetOrderPhoto();
  hideRepeatMatch();
}

async function saveNewCustomer(){
  const name = document.getElementById('custName').value.trim();
  if(!name){ showToast('Please enter a name'); return; }
  const cust = {
    id: uid(),
    name,
    phone: document.getElementById('custPhone').value.trim(),
    address: document.getElementById('custAddress').value.trim(),
    measurements: null,
    createdAt: Date.now()
  };
  await dbPut('customers', cust);
  syncToCloud('customers', cust);
  state.customers.push(cust);
  document.getElementById('custName').value = '';
  document.getElementById('custPhone').value = '';
  document.getElementById('custAddress').value = '';
  closeSheet('customerSheetOverlay');
  renderAll();
  showToast('Customer added');
}

/* ---------------- Sheets ---------------- */
function openSheet(id){ document.getElementById(id).classList.add('active'); }
function closeSheet(id){ document.getElementById(id).classList.remove('active'); }

/* ---------------- Shop settings ---------------- */
async function saveShopName(){
  const name = document.getElementById('shopNameInput').value.trim() || 'Your Tailor Shop';
  state.shopName = name;
  document.getElementById('shopName').textContent = name;
  await dbPut('meta', { key:'shopName', value:name });
  syncShopMeta({ shopName: name });
  localStorage.setItem('fd_shopName', name);
  showToast('Shop name saved');
}

async function changeShopPin(){
  const currentPin = document.getElementById('changePinCurrent').value.trim();
  const newPin = document.getElementById('changePinNew').value.trim();
  const confirmPin = document.getElementById('changePinConfirm').value.trim();
  const errEl = document.getElementById('changePinError');
  errEl.textContent = '';

  if(!currentPin || !newPin || !confirmPin){ errEl.textContent = 'Fill in all three fields'; return; }
  if(newPin.length < 4){ errEl.textContent = 'New PIN must be at least 4 digits'; return; }
  if(newPin !== confirmPin){ errEl.textContent = 'New PINs do not match'; return; }
  if(!navigator.onLine){ errEl.textContent = 'Changing your PIN needs internet'; return; }
  if(!currentShopId){ errEl.textContent = 'Could not find your shop. Try logging out and back in.'; return; }

  try{
    const shopDoc = await fbDb.collection('shops').doc(currentShopId).get();
    if(!shopDoc.exists){ errEl.textContent = 'Could not find your shop'; return; }

    const currentHash = await hashPin(currentPin);
    if(shopDoc.data().pinHash !== currentHash){
      errEl.textContent = 'Current PIN is incorrect';
      return;
    }

    const newHash = await hashPin(newPin);
    await fbDb.collection('shops').doc(currentShopId).set({ pinHash: newHash }, { merge:true });

    document.getElementById('changePinCurrent').value = '';
    document.getElementById('changePinNew').value = '';
    document.getElementById('changePinConfirm').value = '';
    showToast('Shop PIN changed');
  }catch(err){
    errEl.textContent = 'Could not change PIN. Check your internet and try again.';
  }
}

/* ---------------- Backup / restore ---------------- */
function recordBackupSaved(){
  const now = Date.now();
  localStorage.setItem('fd-last-backup-at', String(now));
  updateBackupReminder();
}

function updateBackupReminder(){
  const labelEl = document.getElementById('lastBackupDateLabel');
  const bannerEl = document.getElementById('backupReminderBanner');
  const textEl = document.getElementById('backupReminderText');
  const lastAt = parseInt(localStorage.getItem('fd-last-backup-at') || '0', 10);

  if(labelEl){
    labelEl.textContent = lastAt ? formatDate(new Date(lastAt).toISOString().slice(0,10)) : 'Never';
  }
  if(!bannerEl || !textEl) return;

  const daysSince = lastAt ? Math.floor((Date.now() - lastAt) / (1000*60*60*24)) : null;
  if(daysSince === null){
    bannerEl.style.display = '';
    textEl.textContent = "You haven't saved a backup yet — download one to keep your data safe on your computer too.";
  } else if(daysSince >= 15){
    bannerEl.style.display = '';
    textEl.textContent = `It's been ${daysSince} days since your last backup — save a fresh copy to your computer.`;
  } else {
    bannerEl.style.display = 'none';
  }
}

function exportData(){
  const payload = {
    exportedAt: new Date().toISOString(),
    shopName: state.shopName,
    customers: state.customers,
    orders: state.orders
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fashion-designer-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  recordBackupSaved();
  showToast('Backup downloaded');
}

function exportRecentData(days){
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0,10);

  const recentOrders = state.orders.filter(o => (o.orderDate || '') >= cutoffStr);
  const recentCustomerIds = new Set(recentOrders.map(o => o.customerId));
  const recentCustomers = state.customers.filter(c =>
    recentCustomerIds.has(c.id) ||
    (c.createdAt && new Date(c.createdAt).toISOString().slice(0,10) >= cutoffStr)
  );

  if(recentOrders.length === 0 && recentCustomers.length === 0){
    showToast(`No activity in the last ${days} days`);
    return;
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    rangeDays: days,
    rangeFrom: cutoffStr,
    shopName: state.shopName,
    customers: recentCustomers,
    orders: recentOrders
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fashion-designer-last-${days}-days-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  recordBackupSaved();
  showToast(`Last ${days} days downloaded`);
}

function handleImportFile(e){
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async (evt)=>{
    try{
      const data = JSON.parse(evt.target.result);
      if(!Array.isArray(data.customers) || !Array.isArray(data.orders)) throw new Error('bad format');
      if(!confirm(`Import ${data.customers.length} customers and ${data.orders.length} orders? This will merge with existing data.`)) return;
      for(const c of data.customers){ await dbPut('customers', c); syncToCloud('customers', c); }
      for(const o of data.orders){ await dbPut('orders', o); syncToCloud('orders', o); }
      if(data.shopName){ state.shopName = data.shopName; await dbPut('meta',{key:'shopName', value:data.shopName}); syncShopMeta({shopName:data.shopName}); document.getElementById('shopName').textContent = data.shopName; document.getElementById('shopNameInput').value = data.shopName; }
      state.customers = await dbGetAll('customers');
      state.orders = await dbGetAll('orders');
      renderAll();
      showToast('Backup imported');
    }catch(err){
      showToast('Could not read that file');
    }
  };
  reader.readAsText(file);
}

async function confirmWipe(){
  if(!confirm('Erase ALL customers and orders from this device? This cannot be undone.')) return;
  if(!confirm('Are you absolutely sure? Consider exporting a backup first.')) return;
  await dbClear('customers');
  await dbClear('orders');
  state.customers = [];
  state.orders = [];
  renderAll();
  showToast('All data erased');
  goTo('home');
}

/* ---------------- Toast ---------------- */
let toastTimer;
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.remove('show'), 2200);
}

/* ---------------- Online/offline pill ---------------- */
function updateConnectionPill(){
  const pill = document.getElementById('syncPill');
  const text = document.getElementById('syncText');
  if(navigator.onLine){
    pill.classList.remove('offline');
    text.textContent = currentShopId ? 'Online · synced' : 'Online';
    pill.querySelector('.dot').classList.remove('pulse');
  } else {
    pill.classList.add('offline');
    text.textContent = 'Offline · saved locally';
    pill.querySelector('.dot').classList.remove('pulse');
  }
}
window.addEventListener('online', updateConnectionPill);
window.addEventListener('offline', updateConnectionPill);

/* ---------------- Service worker ---------------- */
function registerSW(){
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
}

/* ---------------- Event bindings ---------------- */
function bindEvents(){
  document.querySelectorAll('.nav-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> goTo(btn.dataset.view));
  });

  document.getElementById('fabAdd').addEventListener('click', ()=>{
    if(state.view === 'customers'){
      openSheet('customerSheetOverlay');
    } else {
      document.getElementById('newOrderDate').value = todayStr();
      openSheet('orderSheetOverlay');
    }
  });

  document.getElementById('homeSearch').addEventListener('input', renderHomeOrders);
  document.getElementById('customerSearch').addEventListener('input', renderCustomersList);
  document.getElementById('orderSearch').addEventListener('input', renderOrdersList);
  document.getElementById('newOrderCustomerPhone').addEventListener('input', checkRepeatCustomer);

  const pickerInput = document.getElementById('customerPickerInput');
  pickerInput.addEventListener('input', ()=>{
    document.getElementById('newOrderCustomer').value = '';
    renderCustomerPickerDropdown(pickerInput.value);
  });
  pickerInput.addEventListener('focus', ()=> renderCustomerPickerDropdown(pickerInput.value));
  document.addEventListener('click', (e)=>{
    const wrap = document.getElementById('customerPickerWrap');
    if(wrap && !wrap.contains(e.target)){
      document.getElementById('customerPickerDropdown').classList.remove('open');
    }
  });

  document.querySelectorAll('#orderFilterSeg button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#orderFilterSeg button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      state.orderFilter = btn.dataset.filter;
      renderOrdersList();
    });
  });

  document.querySelectorAll('#orderStatusSeg button').forEach(btn=>{
    btn.addEventListener('click', ()=> updateOrderStatus(btn.dataset.status));
  });

  document.querySelectorAll('#measureUnitSeg button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#measureUnitSeg button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      state.measureUnit = btn.dataset.unit;
    });
  });

  document.getElementById('orderNotesField').addEventListener('blur', saveOrderNotes);
  document.getElementById('deleteOrderBtn').addEventListener('click', deleteCurrentOrder);
  document.getElementById('importFile').addEventListener('change', handleImportFile);

  document.querySelectorAll('.sheet-overlay').forEach(overlay=>{
    overlay.addEventListener('click', (e)=>{
      if(e.target === overlay) closeSheet(overlay.id);
    });
  });

  window.addEventListener('scroll', ()=>{
    document.getElementById('topbar').classList.toggle('scrolled', window.scrollY > 4);
  });

  renderColorSwatches();
  bindColorCustomInputs();
  bindPhotoInput();
  renderPhotoPreview();
}

document.addEventListener('DOMContentLoaded', init);
