import { useEffect, useMemo, useState, useRef } from 'react';
import { supabase } from './supabaseClient';
import Auth from './Auth';
import './index.css';

export default function App() {
  // Session & UI
  const [session, setSession] = useState(null);
  const [msg, setMsg] = useState('');
  const [mode, setMode] = useState(localStorage.getItem('mode') || 'customer'); // customer | driver

  // Admin (UI-only gating by email)
  const ADMIN_EMAIL =
    process.env.REACT_APP_ADMIN_EMAIL ||
    (typeof import.meta !== 'undefined' ? import.meta.env?.VITE_ADMIN_EMAIL : undefined) ||
    'jbola.03@gmail.com';
  const isAdmin = session?.user?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();

  // Profiles
  const [myProfile, setMyProfile] = useState(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [availableDrivers, setAvailableDrivers] = useState(0);
  const [profilesById, setProfilesById] = useState({});

  // Orders
  const [orders, setOrders] = useState([]);
  const [filter, setFilter] = useState('active'); // active | completed | void | all
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);

  // Create order form
  const [address, setAddress] = useState('');
  const [contact, setContact] = useState('');
  const [orderNotes, setOrderNotes] = useState('');
  const [items, setItems] = useState([{ item_name: '', quantity: 1, notes: '' }]);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);

  // Modal
  const [openOrderId, setOpenOrderId] = useState(null);

  // Chat
  const [messagesByOrder, setMessagesByOrder] = useState({});
  const [draftByOrder, setDraftByOrder] = useState({});
  const [loadingMsgs, setLoadingMsgs] = useState({});


  // Time window
  const startOfTodayISO = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d.toISOString(); }, []);
  const ACTIVE = ['pending','accepted','item_purchased','on_the_way'];
  // Helpers in component scope

// prevents double-submit per orderId without adding UI state
const sendingRef = useRef(new Set()); // Set<orderId>
// avoid duplicate subscriptions in React Strict Mode
const channelRef = useRef(null);

useEffect(() => {
  if (!openOrderId) return;

  // clean up any previous channel before re-subscribing
  if (channelRef.current) {
    supabase.removeChannel(channelRef.current);
    channelRef.current = null;
  }

  const channel = supabase
    .channel(`messages-${openOrderId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'messages', filter: `order_id=eq.${openOrderId}` },
      () => {
        // refresh messages whenever this order’s rows change
        loadMessages(openOrderId);
      }
    )
    .subscribe();

  channelRef.current = channel;

  return () => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
  };
}, [openOrderId]); // re-run when you open a different order

async function openDetails(id, loader) {
  setOpenOrderId(id);
  await loader(id);
}

async function loadMessages(orderId) {
  setLoadingMsgs(p => ({ ...p, [orderId]: true }));
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });
  setLoadingMsgs(p => ({ ...p, [orderId]: false }));
  if (error) return toast('❌ ' + error.message);
  setMessagesByOrder(p => ({ ...p, [orderId]: data || [] }));
}

/**
 * Send a message for an order.
 * If bodyOverride is provided, it is used directly (fixes stale-state issues).
 */
async function sendMessage(orderId, bodyOverride) {
  const body = (bodyOverride ?? draftByOrder[orderId] ?? '').trim();
  if (!body) return;

  // prevent double-submit for this order
  if (sendingRef.current.has(orderId)) return;
  sendingRef.current.add(orderId);

  try {
    // ensure we have an authenticated user for RLS-friendly insert
    const { data: { session } = {} } = await supabase.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) {
      toast('❌ Not authenticated');
      return;
    }

    const { error } = await supabase
      .from('messages')
      .insert([{ order_id: orderId, sender_id: uid, body }]); // RLS-friendly

    if (error) {
      toast('❌ ' + error.message);
      return;
    }

    // clear draft only if we were sending from the draft box
    if (bodyOverride == null) {
      setDraftByOrder(p => ({ ...p, [orderId]: '' }));
    }

    await loadMessages(orderId);
  } finally {
    // always clear the in-flight flag
    sendingRef.current.delete(orderId);
  }
}

async function quickSend(orderId, text) {
  // don’t queue another if one is in-flight
  if (sendingRef.current.has(orderId)) return;

  // (optional) reflect in UI draft if you like:
  setDraftByOrder(p => ({ ...p, [orderId]: text }));

  // send using the override to avoid stale state
  await sendMessage(orderId, text);
}
  // Effects: auth
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: listener } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => listener.subscription.unsubscribe();
  }, []);

  // Effects: profile, drivers
  useEffect(() => { if (session) { loadMyProfile(); countAvailableDrivers(); } }, [session]);

  // Effects: fetch orders
  useEffect(() => { if (session) fetchOrders(); }, [session, mode, startOfTodayISO]);

  // Realtime: orders
  useEffect(() => {
    if (!session) return;
    const notifyAndRefresh = (payload) => {
      const oldS = payload.old?.status, newS = payload.new?.status;
      if (oldS && newS && oldS !== newS) toast(`🔔 ${pretty(oldS)} → ${pretty(newS)}`);
      else if (payload.eventType === 'INSERT') toast('🆕 New order');
      else if (payload.eventType === 'DELETE') toast('🗑️ Order deleted');
      else if (payload.eventType === 'UPDATE') {
        const n = payload.new;
        if (n?.eta_window_start && n?.eta_window_end) toast('⏱️ ETA updated');
      }
      fetchOrders();
    };
    const chCustomer = supabase
      .channel(`orders-user-${session.user.id}`)
      .on('postgres_changes', { event:'*', schema:'public', table:'orders', filter:`user_id=eq.${session.user.id}` }, notifyAndRefresh)
      .subscribe();
    const chDriver = supabase
      .channel(`orders-driver-${session.user.id}`)
      .on('postgres_changes', { event:'*', schema:'public', table:'orders', filter:`accepted_by=eq.${session.user.id}` }, notifyAndRefresh)
      .subscribe();
    return () => { supabase.removeChannel(chCustomer); supabase.removeChannel(chDriver); };
  }, [session]);

  // Realtime: messages
  useEffect(() => {
    if (!session) return;
    const onMessageInsert = (payload) => {
      const m = payload.new; if (!m?.order_id) return;
      setMessagesByOrder(prev => {
        const list = prev[m.order_id] ? [...prev[m.order_id], m] : [m];
        return { ...prev, [m.order_id]: list };
      });
      if (m.sender_id !== session.user.id) toast('💬 New message');
    };
    const chMsgs = supabase
      .channel(`msgs-${session.user.id}`)
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'messages' }, onMessageInsert)
      .subscribe();
    return () => { supabase.removeChannel(chMsgs); };
  }, [session]);

  // Deep-linking: open modal if URL hash is an order id
  useEffect(() => {
    const openFromHash = async () => {
      const id = (window.location.hash || '').replace('#', '');
      if (!id) return;
      // If orders not loaded yet, wait a tick
      const exists = orders.find(o => o.id === id);
      if (exists) {
        setOpenOrderId(id);
        await loadMessages(id);
      }
    };
    openFromHash();
    const onHash = () => {
      const id = (window.location.hash || '').replace('#', '');
      if (id) { setOpenOrderId(id); loadMessages(id); }
      else { setOpenOrderId(null); }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [orders]);

  // Utils
  function toast(t){ setMsg(t); setTimeout(()=>setMsg(''), 3000); }
  function pretty(s){ return (s || '').replace(/_/g,' '); }
  function isAUPhone(s){ const x = s.replace(/\s+/g,''); return /^(\+614\d{8}|04\d{8}|0[2378]\d{8}|1[38]00\d{6})$/.test(x); }
  function etaLabel(o) {
    try {
      if (!o.eta_window_start || !o.eta_window_end) return null;
      const opts = { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Australia/Sydney' };
      const s = new Date(o.eta_window_start).toLocaleTimeString('en-AU', opts);
      const e = new Date(o.eta_window_end).toLocaleTimeString('en-AU', opts);
      return `${s}–${e}`;
    } catch { return null; }
  }
  function mapsUrl(addr){ return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr||'')}`; }
  async function copy(text){
    try { await navigator.clipboard.writeText(text||''); toast('📋 Copied'); }
    catch { toast('❌ Could not copy'); }
  }

  // Profiles
  async function loadMyProfile() {
    const { data, error } = await supabase.from('user_profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (error) return toast('❌ ' + error.message);
    if (!data) {
      const init = { id: session.user.id, display_name: session.user.email.split('@')[0], role: 'customer', is_available: false, avatar_url: null };
      const { error: insErr } = await supabase.from('user_profiles').insert([init]);
      if (insErr) return toast('❌ ' + insErr.message);
      setMyProfile(init);
    } else setMyProfile(data);
  }
  async function saveProfile({ display_name, role, is_available }) {
    setSavingProfile(true);
    const patch = { display_name: display_name ?? myProfile?.display_name ?? '', role: role ?? myProfile?.role ?? 'customer', is_available: !!(is_available ?? myProfile?.is_available) };
    const { data, error } = await supabase.from('user_profiles').update(patch).eq('id', session.user.id).select().maybeSingle();
    setSavingProfile(false);
    if (error) return toast('❌ ' + error.message);
    setMyProfile(data); toast('✅ Profile saved'); countAvailableDrivers();
  }
  async function uploadAvatar(file) {
    if (!file) return;
    const ext = file.name.split('.').pop();
    const path = `${session.user.id}/${Date.now()}.${ext}`;
    const up = await supabase.storage.from('avatars').upload(path, file);
    if (up.error) return toast('❌ ' + up.error.message);
    const { data: url } = supabase.storage.from('avatars').getPublicUrl(path);
    const { error: updErr } = await supabase.from('user_profiles').update({ avatar_url: url.publicUrl }).eq('id', session.user.id);
    if (updErr) return toast('❌ ' + updErr.message);
    setMyProfile(p => ({ ...p, avatar_url: url.publicUrl })); toast('✅ Avatar updated');
  }
  async function countAvailableDrivers(){
    const { count, error } = await supabase
      .from('user_profiles')
      .select('*', { count:'exact', head:true })
      .eq('role', 'driver').eq('is_available', true);
    if (!error) setAvailableDrivers(count || 0);
  }

  // Orders
  async function fetchOrders() {
    let q = supabase
      .from('orders')
      .select('*, order_items ( item_name, quantity, notes )')
      .gte('created_at', startOfTodayISO)
      .order('created_at', { ascending: false });
    if (!isAdmin) {
      if (mode === 'customer') q = q.eq('user_id', session.user.id);
      else if (mode === 'driver') q = q.or(`accepted_by.eq.${session.user.id},accepted_by.is.null`);
    }
    const { data, error } = await q;
    if (error) return toast('❌ ' + error.message);
    setOrders(data || []); await loadProfilesForOrders(data || []);
  }
  async function loadProfilesForOrders(list) {
    const ids = new Set(); list.forEach(o => { if (o.user_id) ids.add(o.user_id); if (o.accepted_by) ids.add(o.accepted_by); });
    if (ids.size === 0) return;
    const { data } = await supabase.from('user_profiles').select('id, display_name, avatar_url, role, is_available').in('id', Array.from(ids));
    const map = {}; (data || []).forEach(p => map[p.id] = p); setProfilesById(map);
  }
  async function uploadImage(orderId, file) {
    if (!file) return; setUploading(true);
    const ext = file.name.split('.').pop();
    const path = `${orderId}/${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage.from('screenshots').upload(path, file);
    if (upErr) { setUploading(false); return toast('❌ ' + upErr.message); }
    const { data: url } = supabase.storage.from('screenshots').getPublicUrl(path);
    const { error: updErr } = await supabase.from('orders').update({ image_url: url.publicUrl }).eq('id', orderId);
    setUploading(false);
    if (updErr) return toast('❌ ' + updErr.message);
    toast('✅ Image uploaded'); fetchOrders();
  }

  // Proof of delivery
  async function uploadPOD(orderId, file) {
    if (!file) return; setUploading(true);
    const ext = file.name.split('.').pop();
    const path = `pod/${orderId}/${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage.from('screenshots').upload(path, file);
    if (upErr) { setUploading(false); return toast('❌ ' + upErr.message); }
    const { data: url } = supabase.storage.from('screenshots').getPublicUrl(path);
    const { error: updErr } = await supabase.from('orders').update({ pod_image_url: url.publicUrl }).eq('id', orderId);
    setUploading(false);
    if (updErr) return toast('❌ ' + updErr.message);
    toast('✅ Proof photo uploaded'); fetchOrders();
  }

  async function deleteOrder(id) {
    if (!isAdmin && mode !== 'customer') return toast('❌ Drivers cannot delete orders');
    if (!window.confirm('Delete this order?')) return;
    if (!isAdmin) {
      const { data: ord, error } = await supabase.from('orders').select('user_id,status').eq('id', id).single();
      if (error) return toast('❌ ' + error.message);
      if (ord.user_id !== session.user.id) return toast('❌ Not your order');
      if (ord.status !== 'pending') return toast('❌ Only pending orders can be deleted');
    }
    const { error: delErr } = await supabase.from('orders').delete().eq('id', id);
    if (delErr) return toast('❌ ' + delErr.message);
    toast('✅ Order deleted'); setOrders(prev => prev.filter(o => o.id !== id));
  }
   async function updateOrderStatus(id, status) {
  const { error } = await supabase.from('orders').update({ status }).eq('id', id);
  if (error) return toast('❌ ' + error.message);
  toast('✅ Status updated'); fetchOrders();
}


  // Client-side guard: one active job per driver
  async function acceptOrder(id) {
    if (myProfile?.role !== 'driver') return toast('❌ Set your profile role to Driver first.');
    if (!myProfile?.is_available) return toast('❌ Toggle “Available” in your profile to accept jobs.');
    const iHaveActive = orders.some(o =>
      o.accepted_by === session.user.id && ['accepted','item_purchased','on_the_way'].includes(o.status)
    );
    if (iHaveActive) return toast('❌ You already have an active job. Complete or void it first.');
    const { error } = await supabase
      .from('orders')
      .update({ accepted_by: session.user.id, status: 'accepted' })
      .eq('id', id).eq('status','pending').is('accepted_by', null);
    if (error) return toast('❌ ' + error.message);
    toast('✅ Order accepted'); fetchOrders();
  }

  // ETA window
  async function setEta(orderId, minutes) {
    if (!minutes && minutes !== 0) return;
    const mins = parseInt(minutes, 10);
    if (Number.isNaN(mins) || mins < 0 || mins > 720) return toast('❌ ETA must be 0–720 minutes');
    const now = new Date();
    const center = new Date(now.getTime() + mins * 60 * 1000);
    const start = new Date(center.getTime() - 5 * 60 * 1000);
    const end = new Date(center.getTime() + 5 * 60 * 1000);
    const { error } = await supabase.from('orders').update({
      eta_minutes: mins, eta_window_start: start.toISOString(), eta_window_end: end.toISOString()
    }).eq('id', orderId);
    if (error) return toast('❌ ' + error.message);
    toast('✅ ETA window updated'); fetchOrders();
  }

  // Void flow
  async function requestVoid(orderId) {
    const reason = window.prompt('Enter reason to request void:');
    if (!reason) return;
    const order = orders.find(o => o.id === orderId);
    if (!order || order.accepted_by !== session.user.id) return toast('❌ Accept the job before requesting a void');
    const { error } = await supabase.from('orders').update({
      void_requested_at: new Date().toISOString(), void_reason: reason
    }).eq('id', orderId);
    if (error) return toast('❌ ' + error.message);
    toast('✅ Void requested — waiting for customer'); fetchOrders();
  }
  async function confirmVoid(orderId) {
    if (!window.confirm('Confirm void?')) return;
    const { error } = await supabase.from('orders').update({ status: 'void' }).eq('id', orderId);
    if (error) return toast('❌ ' + error.message);
    toast('✅ Order voided'); fetchOrders();
  }
  async function cancelVoid(orderId) {
    const { error } = await supabase.from('orders').update({ void_requested_at: null, void_reason: null }).eq('id', orderId);
    if (error) return toast('❌ ' + error.message);
    toast('✅ Kept order active'); fetchOrders();
  }

  // Create order helpers
  const updateItem = (idx, patch) => setItems(items.map((it,i)=> i===idx ? { ...it, ...patch } : it));
  const removeItem = (idx) => { if (items.length === 1) return; setItems(items.filter((_,i)=>i!==idx)); };
  const addItem = () => setItems(prev => [...prev, { item_name:'', quantity:1, notes:'' }]);

  async function submitOrder() {
    if (!address.trim()) return toast('❌ Delivery address required');
    if (!contact.trim() || !isAUPhone(contact)) return toast('❌ Valid AU contact number required');

    const cleanItems = items
      .map(it => ({ ...it, item_name:(it.item_name||'').trim(), quantity: parseInt(it.quantity,10)||1, notes:(it.notes||'').trim() }))
      .filter(it => it.item_name && it.quantity>0);
    if (!cleanItems.length) return toast('❌ Add at least one item');

    const { data: orderData, error: orderErr } = await supabase.from('orders').insert([{
      user_id: session.user.id,
      status:'pending',
      delivery_address: address.trim(),
      contact_number: contact.trim(),
      ai_notes: orderNotes.trim()
    }]).select();
    if (orderErr) return toast('❌ ' + orderErr.message);
    const orderId = orderData[0].id;

    const rows = cleanItems.map(it => ({ order_id: orderId, item_name: it.item_name, quantity: it.quantity, notes: it.notes }));
    const { error: itemErr } = await supabase.from('order_items').insert(rows);
    if (itemErr) return toast('❌ ' + itemErr.message);

    if (imageFile) await uploadImage(orderId, imageFile);

    // Reset
    setAddress(''); setContact(''); setOrderNotes('');
    setItems([{ item_name:'', quantity:1, notes:'' }]); setImageFile(null); setImagePreview(null);
    toast('✅ Order created'); fetchOrders();
  }

  // Admin purge via RPC
  async function purgeOlderThanToday() {
    if (!isAdmin) return toast('❌ Admin only');
    if (!window.confirm('Purge ALL orders created before today? This cannot be undone.')) return;
    const { data, error } = await supabase.rpc('purge_old_orders');
    if (error) return toast('❌ ' + error.message);
    toast(`✅ Purged ${data || 0} old orders`); fetchOrders();
  }

  // Derived lists
  if (!session) {
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <Auth onAuth={() => window.location.reload()} />
      </div>
    );
  }
  const activeOrders = orders.filter(o => ACTIVE.includes(o.status));
  const completedOrders = orders.filter(o => o.status === 'delivered');
  const voidOrders = orders.filter(o => o.status === 'void');

  let filteredOrders = orders;
  if (filter==='active') filteredOrders = activeOrders;
  if (filter==='completed') filteredOrders = completedOrders;
  if (filter==='void') filteredOrders = voidOrders;

  // Search (address/contact/notes/items)
  const q = search.trim().toLowerCase();
  if (q) {
    filteredOrders = filteredOrders.filter(o => {
      const fields = [
        o.delivery_address || '',
        o.contact_number || '',
        o.ai_notes || '',
        (o.order_items || []).map(i => i.item_name).join(' ')
      ].join(' ').toLowerCase();
      return fields.includes(q);
    });
  }

  return (
    <div className="min-h-screen bg-gray-950 text-slate-100">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/70 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-xl font-bold">JobRun — Bunnings Delivery</div>
            <span className="badge">Today</span>
            <span className="badge">Drivers online: {availableDrivers}</span>
            {myProfile?.role && <span className="badge">You: {myProfile.role}</span>}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-400">Signed in as <code>{session.user.email}</code></span>
            <button className="btn btn-danger" onClick={() => supabase.auth.signOut()}>Logout</button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Profile & Controls & Create */}
        <aside className="space-y-6">
          <div className="card p-4">
            <ProfileCard
              session={session}
              myProfile={myProfile}
              onSave={saveProfile}
              onAvatar={uploadAvatar}
              saving={savingProfile}
            />
          </div>

          <div className="card p-4 space-y-4">
            {/* Mode */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-slate-300 font-medium">Mode:</span>
              <button className="btn" onClick={() => { setMode('customer'); localStorage.setItem('mode','customer'); }} disabled={mode==='customer'}>Customer</button>
              <button className="btn" onClick={() => { setMode('driver'); localStorage.setItem('mode','driver'); }} disabled={mode==='driver'}>Driver</button>
            </div>
            {/* Filter */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-slate-300 font-medium">Filter:</span>
              <button className="btn" onClick={() => setFilter('active')} disabled={filter==='active'}>Active ({activeOrders.length})</button>
              <button className="btn" onClick={() => setFilter('completed')} disabled={filter==='completed'}>Completed ({completedOrders.length})</button>
              <button className="btn" onClick={() => setFilter('void')} disabled={filter==='void'}>Voided ({voidOrders.length})</button>
              <button className="btn" onClick={() => setFilter('all')} disabled={filter==='all'}>All ({orders.length})</button>
            </div>

            {/* Admin purge */}
            {isAdmin && (
              <button className="btn btn-danger w-full" onClick={purgeOlderThanToday}>
                Admin: Purge orders before today
              </button>
            )}
          </div>

          {msg && <div className="toast">{msg}</div>}

          {mode === 'customer' && (
            <div className="card p-4 space-y-4">
              <h3 className="text-lg font-semibold">Create New Order</h3>
              <input className="input" value={address} onChange={(e)=>setAddress(e.target.value)} placeholder="Delivery address" />
              <input className="input" value={contact} onChange={(e)=>setContact(e.target.value)} placeholder="Site contact number (AU)" onBlur={()=>{ if (contact && !isAUPhone(contact)) toast('❌ Valid AU phone e.g. 04xx xxx xxx'); }} />
              <textarea className="input" value={orderNotes} onChange={(e)=>setOrderNotes(e.target.value)} placeholder="Order notes (optional)" />

              <div>
                <div className="font-medium text-slate-200">Items</div>
                {items.map((it, idx) => (
                  <div key={idx} className="mt-2 grid grid-cols-6 gap-2">
                    <input className="input col-span-3" value={it.item_name} onChange={(e)=>updateItem(idx,{ item_name: e.target.value })} placeholder="Item name" />
                    <input className="input col-span-1" type="number" min="1" value={it.quantity}
                      onChange={(e)=>updateItem(idx,{ quantity: Math.max(1, parseInt(e.target.value||'1',10)) })} placeholder="Qty" />
                    <input className="input col-span-2" value={it.notes} onChange={(e)=>updateItem(idx,{ notes: e.target.value })} placeholder="Notes (SKU, color…)" />
                    <div className="col-span-6">
                      <button className="btn" onClick={()=>removeItem(idx)} disabled={items.length===1}>Remove</button>
                    </div>
                  </div>
                ))}
                <button className="btn mt-2" onClick={addItem}>+ Add another item</button>
              </div>

              <div>
                <div className="font-medium text-slate-200">Screenshot (optional)</div>
                <div className="flex items-center gap-3 mt-2">
                  <input type="file" accept="image/*" onChange={(e)=>{
                    const f = e.target.files?.[0] || null; setImageFile(f);
                    if (f) { const r=new FileReader(); r.onload=()=>setImagePreview(r.result); r.readAsDataURL(f); } else setImagePreview(null);
                  }} />
                  {imagePreview && <img src={imagePreview} alt="preview" className="h-20 rounded-lg border border-slate-800" />}
                </div>
              </div>

              <button className="btn btn-primary" onClick={submitOrder} disabled={uploading}>
                {uploading ? 'Uploading…' : 'Submit Order'}
              </button>
            </div>
          )}
        </aside>

        {/* Right: Orders list */}
        <section className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold">Orders (Today)</h3>
            <input
              className="input w-72"
              placeholder="Search address, contact, items…"
              value={search}
              onChange={(e)=>setSearch(e.target.value)}
            />
          </div>

          {filteredOrders.length === 0 ? (
            <div className="card p-6 text-sm text-slate-400">
              No orders match the current filter. Create one in <strong>Customer</strong> mode or adjust the filter/search.
            </div>
          ) : filteredOrders.map(order => {
            const driver = order.accepted_by ? profilesById[order.accepted_by] : null;
            return (
              <div key={order.id} className="card p-4">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="badge">{pretty(order.status)}</span>
                      {order.accepted_by && <span className="badge">Driver: {driver?.display_name || 'Driver'}</span>}
                      {etaLabel(order) && ACTIVE.includes(order.status) && (
                        <span className="badge">ETA {etaLabel(order)}</span>
                      )}
                      {order.pod_image_url && <span className="badge">POD ✓</span>}
                    </div>
                    <div className="text-sm text-slate-300 mt-1 truncate">
                      {order.delivery_address} • {order.contact_number}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Open in Maps + copy address */}
                    <a className="btn" href={mapsUrl(order.delivery_address)} target="_blank" rel="noreferrer">Open in Maps</a>
                    <button className="btn" onClick={()=>copy(order.delivery_address)}>Copy address</button>

                    {mode==='driver' && order.status==='pending' && (
                      <button
                        className="btn btn-primary"
                        onClick={()=>acceptOrder(order.id)}
                        disabled={myProfile?.role!=='driver' || !myProfile?.is_available}
                        title={myProfile?.role!=='driver' ? 'Set role to Driver' : (!myProfile?.is_available ? 'Toggle Available in your profile' : 'Accept')}
                      >
                        Accept
                      </button>
                    )}
                    <button
                      className="btn"
                      onClick={()=>{ setOpenOrderId(order.id); loadMessages(order.id); window.location.hash = order.id; }}
                      title="View details"
                    >
                      View
                    </button>
                    {((mode==='customer' && order.status==='pending') || isAdmin) && (
                      <button className="btn" onClick={()=>deleteOrder(order.id)}>Delete</button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      </main>

      {/* Modal */}
      {openOrderId && (
        <OrderModal
          order={orders.find(o=>o.id===openOrderId)}
          profilesById={profilesById}
          session={session}
          mode={mode}
          setEta={setEta}
          updateOrderStatus={updateOrderStatus}
          requestVoid={requestVoid}
          confirmVoid={confirmVoid}
          cancelVoid={cancelVoid}
          uploadImage={uploadImage}
          uploadPOD={uploadPOD}
          messages={messagesByOrder[openOrderId] || []}
          loading={!!loadingMsgs[openOrderId]}
          draft={draftByOrder[openOrderId] || ''}
          setDraft={(v)=>setDraftByOrder(p=>({ ...p, [openOrderId]: v }))}
          loadMessages={()=>loadMessages(openOrderId)}
          sendMessage={()=>sendMessage(openOrderId)}
          quickSend={(t)=>quickSend(openOrderId, t)}
          close={()=>{ setOpenOrderId(null); if (window.location.hash) window.location.hash=''; }}
        />
      )}
    </div>
  );


}
/* ===== Small components ===== */

function OrderTimeline({ status }) {
  const STATUSES = ['pending','accepted','item_purchased','on_the_way','delivered'];
  const idx = status === 'void' ? -1 : STATUSES.indexOf(status);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {STATUSES.map((s,i)=>{
        const done = idx > i, current = idx === i;
        return (
          <div key={s} className="flex items-center gap-2">
            <div
              title={s.replace(/_/g,' ')}
              className={`w-4 h-4 rounded-full border-2 border-slate-600 ${done ? 'bg-emerald-400/40' : current ? 'bg-amber-300/40' : 'bg-slate-900'}`}
            />
            <small className="capitalize text-slate-300">{s.replace(/_/g,' ')}</small>
            {i < STATUSES.length-1 && <div className="w-7 h-0.5 bg-slate-700" />}
          </div>
        );
      })}
      {status==='void' && <span className="badge">void</span>}
    </div>
  );
}

function EtaEditor({ order, onSet }) {
  const [val, setVal] = useState(order.eta_minutes ?? '');
  return (
    <div className="flex items-center gap-2">
      <input className="input w-36" type="number" min="0" max="720" value={val} onChange={(e)=>setVal(e.target.value)} placeholder="ETA (min)" />
      <button className="btn" onClick={()=>onSet(val)}>Set ETA</button>
    </div>
  );
}

function Avatar({ url, size = 36 }) {
  return url
    ? <img src={url} alt="" style={{ width:size, height:size, borderRadius:size }} className="border border-slate-800 object-cover" />
    : <div style={{ width:size, height:size, borderRadius:size }} className="border border-slate-800 bg-slate-900" />;
}

function ProfileCard({ session, myProfile, onSave, onAvatar, saving }) {
  const [name, setName] = useState(myProfile?.display_name || '');
  const [role, setRole] = useState(myProfile?.role || 'customer');
  const [avail, setAvail] = useState(!!myProfile?.is_available);

  useEffect(()=>{ setName(myProfile?.display_name||''); setRole(myProfile?.role||'customer'); setAvail(!!myProfile?.is_available); },[myProfile]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Avatar url={myProfile?.avatar_url} />
        <div>
          <div className="font-semibold">{name || 'Your Profile'}</div>
          <div className="text-xs text-slate-400">Email: {session.user.email}</div>
        </div>
      </div>
      <div className="grid gap-2">
        <input className="input" value={name} onChange={(e)=>setName(e.target.value)} placeholder="Display name" />
        <select className="input" value={role} onChange={(e)=>setRole(e.target.value)}>
          <option value="customer">Customer</option>
          <option value="driver">Driver</option>
          <option value="admin">Admin</option>
        </select>
        {role==='driver' && (
          <label className="text-sm text-slate-300 inline-flex items-center gap-2">
            <input type="checkbox" checked={avail} onChange={(e)=>setAvail(e.target.checked)} />
            Available
          </label>
        )}
        <button className="btn btn-primary" disabled={saving} onClick={()=>onSave({ display_name: name, role, is_available: avail })}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <div>
          <input type="file" accept="image/*" onChange={(e)=> onAvatar(e.target.files?.[0])} />
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <h4 className="text-base font-semibold">{children}</h4>;
}

function OrderModal(props) {
  const {
    order, profilesById, session, mode,
    setEta, updateOrderStatus, requestVoid, confirmVoid, cancelVoid,
    uploadImage, uploadPOD, messages, loading, draft, setDraft, loadMessages, sendMessage, quickSend,
    close
  } = props;

  // Hooks MUST be before any early returns
  const [pendingShot, setPendingShot] = useState(null);
  const [pendingPod, setPendingPod] = useState(null);
  const [uploadingShot, setUploadingShot] = useState(false);
  const [uploadingPod, setUploadingPod] = useState(false);

  if (!order) return null;

  const driver = order.accepted_by ? profilesById[order.accepted_by] : null;
  const customer = order.user_id ? profilesById[order.user_id] : null;

  function formatEta(o){
    try {
      const opts = { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Australia/Sydney' };
      const s = new Date(o.eta_window_start).toLocaleTimeString('en-AU', opts);
      const e = new Date(o.eta_window_end).toLocaleTimeString('en-AU', opts);
      return `${s}–${e}`;
    } catch { return null; }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
      onClick={close}
    >
      <div className="card w-full max-w-3xl p-4" onClick={(e)=>e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <OrderTimeline status={order.status} />
          <button className="btn" onClick={close}>Close</button>
        </div>

        <div className="grid gap-3">
          {/* Chips */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="badge">Status: {order.status.replace(/_/g,' ')}</span>
            {order.eta_window_start && order.eta_window_end && (
              <span className="badge">ETA {formatEta(order)}</span>
            )}
            {driver && <span className="badge">Driver: {driver.display_name || 'Driver'}</span>}
            {customer && <span className="badge">Customer: {customer.display_name || 'Customer'}</span>}
            {order.pod_image_url && <span className="badge">POD ✓</span>}
          </div>

          {/* Details */}
          <div className="grid md:grid-cols-2 gap-3">
            <div className="card p-3">
              <SectionTitle>Job Details</SectionTitle>
              <div className="text-sm text-slate-300 mt-1">Address</div>
              <div className="flex items-center gap-2">
                <span>{order.delivery_address}</span>
                <a
                  className="btn"
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.delivery_address||'')}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Maps
                </a>
                <button className="btn" onClick={()=>navigator.clipboard.writeText(order.delivery_address||'')}>Copy</button>
              </div>
              <div className="text-sm text-slate-300 mt-2">Contact</div>
              <div>{order.contact_number}</div>
              {order.ai_notes && (
                <>
                  <div className="text-sm text-slate-300 mt-2">Notes</div>
                  <div>{order.ai_notes}</div>
                </>
              )}
            </div>

            <div className="card p-3">
              <SectionTitle>People</SectionTitle>
              <div className="flex items-center gap-4 mt-2">
                {driver && (
                  <div className="flex items-center gap-2">
                    <Avatar url={driver.avatar_url} />
                    <div className="text-sm">Driver: <strong>{driver.display_name || 'Driver'}</strong></div>
                  </div>
                )}
                {customer && (
                  <div className="flex items-center gap-2">
                    <Avatar url={customer.avatar_url} />
                    <div className="text-sm">Customer: <strong>{customer.display_name || 'Customer'}</strong></div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Items & Images */}
          <div className="grid md:grid-cols-2 gap-3">
            <div className="card p-3">
              <SectionTitle>Items</SectionTitle>
              {order.order_items?.length ? (
                <ul className="list-disc pl-5 mt-2">
                  {order.order_items.map((it,i)=>(
                    <li key={i}>🛒 {it.quantity}× {it.item_name}{it.notes ? ` — ${it.notes}` : ''}</li>
                  ))}
                </ul>
              ) : (
                <div className="text-sm text-slate-400">No items.</div>
              )}
            </div>

            <div className="card p-3 space-y-2">
              <SectionTitle>Images</SectionTitle>
              <div className="grid grid-cols-2 gap-2">
                {/* Customer screenshot */}
                <div>
                  <div className="text-xs text-slate-400 mb-1">Customer screenshot</div>
                  {order.image_url
                    ? <img src={order.image_url} alt="uploaded" className="rounded-lg border border-slate-800 max-h-56" />
                    : <div className="text-sm text-slate-400">No screenshot.</div>}

                  {mode==='customer' && (
                    <div className="mt-2 space-y-2">
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e)=> setPendingShot(e.target.files?.[0] || null)}
                      />
                      {pendingShot && (
                        <div className="flex items-center gap-2">
                          <img
                            src={URL.createObjectURL(pendingShot)}
                            alt="preview"
                            className="h-16 rounded border border-slate-800 object-cover"
                          />
                          <button
                            className="btn btn-primary"
                            disabled={uploadingShot}
                            onClick={async ()=>{
                              setUploadingShot(true);
                              await uploadImage(order.id, pendingShot);
                              setUploadingShot(false);
                              setPendingShot(null);
                            }}
                          >
                            {uploadingShot ? 'Uploading…' : 'Upload'}
                          </button>
                          <button className="btn" onClick={()=>setPendingShot(null)}>Cancel</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Proof of delivery */}
                <div>
                  <div className="text-xs text-slate-400 mb-1">Proof of delivery (driver)</div>
                  {order.pod_image_url
                    ? <img src={order.pod_image_url} alt="pod" className="rounded-lg border border-slate-800 max-h-56" />
                    : <div className="text-sm text-slate-400">No proof uploaded.</div>}

                  {mode==='driver' && (
                    <div className="mt-2 space-y-2">
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e)=> setPendingPod(e.target.files?.[0] || null)}
                      />
                      {pendingPod && (
                        <div className="flex items-center gap-2">
                          <img
                            src={URL.createObjectURL(pendingPod)}
                            alt="preview"
                            className="h-16 rounded border border-slate-800 object-cover"
                          />
                          <button
                            className="btn btn-primary"
                            disabled={uploadingPod}
                            onClick={async ()=>{
                              setUploadingPod(true);
                              await uploadPOD(order.id, pendingPod);
                              setUploadingPod(false);
                              setPendingPod(null);
                            }}
                          >
                            {uploadingPod ? 'Uploading…' : 'Upload'}
                          </button>
                          <button className="btn" onClick={()=>setPendingPod(null)}>Cancel</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Driver actions */}
          {mode==='driver' && (
            <div className="card p-3">
              <SectionTitle>Driver Actions</SectionTitle>
              <div className="flex flex-wrap gap-2 mt-2">
                {order.status==='pending' && <span className="text-sm text-slate-400">Accept from the list.</span>}
                {order.status==='accepted' && (
                  <>
                    <button className="btn btn-warn" onClick={()=>updateOrderStatus(order.id,'item_purchased')}>Item Purchased</button>
                    <EtaEditor order={order} onSet={(mins)=>setEta(order.id, mins)} />
                  </>
                )}
                {order.status==='item_purchased' && (
                  <>
                    <button className="btn btn-warn" onClick={()=>updateOrderStatus(order.id,'on_the_way')}>On the Way</button>
                    <EtaEditor order={order} onSet={(mins)=>setEta(order.id, mins)} />
                  </>
                )}
                {order.status==='on_the_way' && (
                  <>
                    <button
                      className="btn btn-primary"
                      onClick={()=>updateOrderStatus(order.id,'delivered')}
                      title="Mark as delivered"
                    >
                      Mark Delivered
                    </button>
                    <EtaEditor order={order} onSet={(mins)=>setEta(order.id, mins)} />
                  </>
                )}
                {['accepted','item_purchased','on_the_way'].includes(order.status) && (
                  order.void_requested_at
                    ? <span className="badge">Void requested — waiting for customer</span>
                    : <button className="btn" onClick={()=>requestVoid(order.id)}>Request Void</button>
                )}
              </div>
            </div>
          )}

          {/* Customer: void decision */}
          {mode==='customer' && order.void_requested_at && order.status!=='void' && (
            <div className="card p-3">
              <SectionTitle>Void Request</SectionTitle>
              {order.void_reason && <div className="mb-2">Reason: {order.void_reason}</div>}
              <div className="flex gap-2">
                <button className="btn btn-danger" onClick={()=>confirmVoid(order.id)}>Confirm Void</button>
                <button className="btn" onClick={()=>cancelVoid(order.id)}>Keep Order</button>
              </div>
            </div>
          )}

          {/* Chat */}
          <div className="card p-3">
            <SectionTitle>Messages</SectionTitle>
            <div className="mt-2 space-y-2">
              {loading ? (
                <p className="text-sm text-slate-400">Loading messages…</p>
              ) : messages.length ? (
                <div className="space-y-2 max-h-64 overflow-auto pr-1">
                  {messages.map(m => {
                    const sender = profilesById[m.sender_id];
                    const name = m.sender_id === session.user.id ? 'You' : (sender?.display_name || 'Other');
                    return (
                      <div key={m.id}>
                        <div className="text-xs text-slate-400">
                          <strong>{name}:</strong> {new Date(m.created_at).toLocaleString()}
                        </div>
                        <div>{m.body}</div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-slate-400">No messages yet.</p>
              )}

              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  value={draft}
                  onChange={(e)=>setDraft(e.target.value)}
                  placeholder={mode==='driver' ? 'Ask a question or send an update…' : 'Send a message to your driver…'}
                />
                <button className="btn btn-primary" onClick={sendMessage}>Send</button>
              </div>

              {mode==='driver' && (
                <div className="flex flex-wrap gap-2">
                  <button className="btn" onClick={()=>quickSend('Hi! I have accepted your job 👍')}>Accepted 👍</button>
                  <button className="btn" onClick={()=>quickSend('Item has been purchased ✅')}>Purchased ✅</button>
                  <button className="btn" onClick={()=>quickSend('On the way. ETA ~20 minutes 🕒')}>ETA 20m 🕒</button>
                  <button className="btn" onClick={()=>quickSend('Delivered. Thanks! 📦')}>Delivered 📦</button>
                </div>
              )}
            </div> {/* end Chat inner */}
          </div>   {/* end Chat card */}
        </div>     {/* end grid gap-3 */}
      </div>       {/* end modal inner card */}
      {/* end overlay */}
    </div>
  );
}




