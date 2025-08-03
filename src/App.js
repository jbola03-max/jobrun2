import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import Auth from './Auth';

function App() {
  const [session, setSession] = useState(null);
  const [orders, setOrders] = useState([]);
  const [mode, setMode] = useState(localStorage.getItem('mode') || 'customer');
  const [statusFilter, setStatusFilter] = useState('pending');
  const [message, setMessage] = useState('');

  const isAdmin = session?.user?.email?.endsWith('@admin.com');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    fetchOrders();
  }, [session, mode, statusFilter]);

  const fetchOrders = async () => {
    let query = supabase
      .from('orders')
      .select(`*, order_items ( item_name, quantity, notes )`)
      .order('created_at', { ascending: false });

    if (!isAdmin) {
      if (mode === 'customer') query = query.eq('user_id', session.user.id);
      if (mode === 'driver') query = query.eq('accepted_by', session.user.id);
    }

    query = query.eq('status', statusFilter);
    const { data } = await query;
    if (data) setOrders(data);
  };

  const handleSetMode = (m) => {
    setMode(m);
    localStorage.setItem('mode', m);
    setStatusFilter('pending');
  };

  const showMessage = (msg) => {
    setMessage(msg);
    setTimeout(() => setMessage(''), 3000);
  };

  const deleteOrder = async (id) => {
    const { error } = await supabase.from('orders').delete().eq('id', id);
    if (error) return showMessage('❌ ' + error.message);
    showMessage('✅ Order deleted');
    setOrders(prev => prev.filter(o => o.id !== id));
  };

  const updateOrderStatus = async (id, newStatus) => {
    const { error } = await supabase.from('orders').update({ status: newStatus }).eq('id', id);
    if (error) return showMessage('❌ ' + error.message);
    showMessage('✅ Status updated');
    fetchOrders();
  };

  if (!session) return <Auth onAuth={() => window.location.reload()} />;

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Bunnings Delivery</h1>
      <p>Logged in as: <code>{session.user.email}</code></p>
      <button onClick={() => supabase.auth.signOut()}>Logout</button>

      <div style={{ marginTop: '1rem' }}>
        <strong>Mode:</strong>
        <button onClick={() => handleSetMode('customer')} disabled={mode === 'customer'}>Customer</button>
        <button onClick={() => handleSetMode('driver')} disabled={mode === 'driver'} style={{ marginLeft: '1rem' }}>Driver</button>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <strong>Status:</strong>
        {['pending', 'accepted', 'delivered'].map(status => (
          <button key={status} onClick={() => setStatusFilter(status)} disabled={statusFilter === status} style={{ marginLeft: '1rem' }}>
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      {message && <div style={{ background: '#ddf', padding: '1rem', marginTop: '1rem' }}>{message}</div>}

      {mode === 'customer' && statusFilter === 'pending' && (
        <>
          <h3 style={{ marginTop: '2rem' }}>Create New Order</h3>
          <form onSubmit={async (e) => {
            e.preventDefault();
            const form = e.target;
            const { address, itemName, quantity, notes } = form.elements;

            const { data: orderData, error: orderError } = await supabase.from('orders').insert([{
              user_id: session.user.id,
              status: 'pending',
              delivery_address: address.value,
              ai_notes: notes.value
            }]).select();

            if (orderError) return showMessage('❌ ' + orderError.message);

            const orderId = orderData[0].id;
            const { error: itemError } = await supabase.from('order_items').insert([{
              order_id: orderId,
              item_name: itemName.value,
              quantity: parseInt(quantity.value),
              notes: notes.value
            }]);

            if (itemError) return showMessage('❌ ' + itemError.message);

            showMessage('✅ Order created');
            form.reset();
            fetchOrders();
          }}>
            <input name="address" placeholder="Delivery address" required /><br /><br />
            <input name="itemName" placeholder="Item name" required /><br /><br />
            <input name="quantity" type="number" placeholder="Quantity" defaultValue="1" required /><br /><br />
            <textarea name="notes" placeholder="Any notes" /><br /><br />
            <button type="submit">Submit Order</button>
          </form>
        </>
      )}

      <h3 style={{ marginTop: '2rem' }}>{isAdmin ? 'All Orders' : 'Orders'}</h3>
      {orders.length === 0 ? <p>No orders.</p> : orders.map(order => (
        <div key={order.id} style={{ border: '1px solid #ccc', padding: '1rem', marginBottom: '1rem' }}>
          <p><strong>Status:</strong> {order.status}</p>
          <p><strong>Address:</strong> {order.delivery_address}</p>
          <p><strong>Notes:</strong> {order.ai_notes}</p>
          {order.order_items?.map((item, i) => (
            <div key={i}><em>🛒 {item.quantity}x {item.item_name}</em> {item.notes && `– ${item.notes}`}</div>
          ))}

          {(mode === 'driver' && statusFilter === 'pending') && (
            <button onClick={async () => {
              const { error } = await supabase
                .from('orders')
                .update({ accepted_by: session.user.id, status: 'accepted' })
                .eq('id', order.id)
                .eq('status', 'pending')
                .is('accepted_by', null);
              if (error) return showMessage('❌ ' + error.message);
              showMessage('✅ Order accepted!');
              fetchOrders();
            }}>Accept</button>
          )}

          {(mode === 'driver' && statusFilter === 'accepted') && (
            <button onClick={() => updateOrderStatus(order.id, 'delivered')}>Mark Delivered</button>
          )}

          {isAdmin && (
            <select defaultValue={order.status} onChange={(e) => updateOrderStatus(order.id, e.target.value)}>
              <option value="pending">Pending</option>
              <option value="accepted">Accepted</option>
              <option value="delivered">Delivered</option>
            </select>
          )}

          {(order.status === 'pending' || isAdmin) && <button onClick={() => deleteOrder(order.id)} style={{ marginLeft: '1rem' }}>Delete</button>}
        </div>
      ))}
    </div>
  );
}

export default App;
