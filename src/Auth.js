import { useState } from 'react';
import { supabase } from './supabaseClient';

export default function Auth({ onAuth }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (type) => {
    setLoading(true);
    setError('');

    const { data, error } = type === 'signup'
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
    } else {
      onAuth(data);
    }

    setLoading(false);
  };

  return (
    <div style={{ padding: '2rem' }}>
      <h2>Login or Sign Up</h2>
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={e => setEmail(e.target.value)}
      /><br /><br />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={e => setPassword(e.target.value)}
      /><br /><br />
      <button onClick={() => handleLogin('login')} disabled={loading}>Login</button>
      <button onClick={() => handleLogin('signup')} disabled={loading}>Sign Up</button>
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  );
}
