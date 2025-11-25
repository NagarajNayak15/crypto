import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { ssddEncrypt, ssddDecrypt } from './CryptoEngine';
import './App.css'; // Assume basic styling or Tailwind

// Detect local setup - user can override in UI
const DEFAULT_PORT = 4000;
const HOST = window.location.hostname; 

function App() {
  const [role, setRole] = useState('setup'); // setup, client, dht
  const [myPort, setMyPort] = useState(DEFAULT_PORT);
  
  // Client State
  const [dhtIp, setDhtIp] = useState(`http://${HOST}:4000`);
  const [receiverIp, setReceiverIp] = useState(`http://${HOST}:4000`);
  const [message, setMessage] = useState('');
  const [ttl, setTtl] = useState(60);
  const [logs, setLogs] = useState([]);
  const [inbox, setInbox] = useState([]);

  // DHT State
  const [dhtData, setDhtData] = useState([]);
  const [socket, setSocket] = useState(null);

  // --- SETUP & SOCKETS ---
  useEffect(() => {
    // Connect to own backend for real-time events
    const newSocket = io(`http://${HOST}:${myPort}`);
    setSocket(newSocket);

    // Listener for DHT updates
    newSocket.on('dht_update', (data) => {
      setDhtData(data);
    });

    // Listener for Incoming Messages (Receiver)
    newSocket.on('incoming_message', (data) => {
      addLog(`Received encrypted package! Fetching keys from DHT...`);
      handleIncomingMessage(data);
    });

    return () => newSocket.close();
  }, [myPort]);

  const addLog = (msg) => setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);

  // --- CORE LOGIC: SENDER ---
  const handleSend = async () => {
    try {
      addLog("Encrypting...");
      const { incompleteCiphertext, shares } = ssddEncrypt(message, ttl);

      // 1. Send Shares to DHT
      addLog(`Distributing ${shares.length} Key Shares to DHT (${dhtIp})...`);
      
      // We upload shares individually to simulate distributed nature
      // Ideally, different shares go to different nodes. Here, all go to one DHT.
      const shareIds = [];
      for (let i = 0; i < shares.length; i++) {
        // Random ID for the share
        const shareId = Math.random().toString(36).substring(7);
        shareIds.push(shareId);
        
        await axios.post(`${dhtIp}/dht/store`, {
          shareId,
          shareData: shares[i],
          ttlSeconds: ttl
        });
      }

      // 2. Send Incomplete Ciphertext to Receiver
      addLog(`Sending Incomplete Ciphertext to Receiver (${receiverIp})...`);
      await axios.post(`${receiverIp}/client/receive`, {
        incompleteCiphertext,
        shareIds,
        dhtIp // Tell receiver where to find keys
      });

      addLog("Sent successfully! Data will self-destruct in " + ttl + "s");
      setMessage("");

    } catch (err) {
      addLog(`Error: ${err.message}`);
    }
  };

  // --- CORE LOGIC: RECEIVER ---
  const handleIncomingMessage = async (pkg) => {
    try {
      const { incompleteCiphertext, shareIds, dhtIp: senderDhtIp } = pkg;
      
      // 1. Fetch Shares from DHT
      const recoveredShares = [];
      for (let id of shareIds) {
        try {
          const res = await axios.get(`${senderDhtIp}/dht/retrieve/${id}`);
          recoveredShares.push(res.data.shareData);
        } catch (e) {
          addLog(`Share ${id} is missing or expired.`);
        }
      }

      // 2. Attempt Decrypt
      if (recoveredShares.length < 2) {
        setInbox(prev => [...prev, { body: "--- DECRYPTION FAILED: KEYS EXPIRED ---", timestamp: Date.now(), status: 'failed' }]);
        addLog("Failed to recover enough keys. Data is lost forever.");
        return;
      }

      const plaintext = ssddDecrypt(incompleteCiphertext, recoveredShares);
      if (plaintext) {
        setInbox(prev => [...prev, { body: plaintext, timestamp: Date.now(), status: 'success' }]);
        addLog("Decryption successful!");
      } else {
        addLog("Decryption failed (Tampered data?)");
      }

    } catch (err) {
      addLog("System Error during retrieval");
    }
  };

  // --- RENDER HELPERS ---
  const renderSetup = () => (
    <div className="card">
      <h2>System Configuration</h2>
      <label>Local Port (This Device):</label>
      <input type="number" value={myPort} onChange={e => setMyPort(e.target.value)} />
      
      <div className="role-select">
        <button onClick={() => setRole('client')}>Start as Client (Sender/Receiver)</button>
        <button onClick={() => setRole('dht')} className="btn-secondary">Start as DHT Node</button>
      </div>
    </div>
  );

  const renderClient = () => (
    <div className="container">
      <div className="header">
        <h1>SSDD Client Node</h1>
        <button onClick={() => setRole('setup')}>Exit</button>
      </div>

      <div className="grid">
        {/* SENDER PANEL */}
        <div className="card">
          <h3>Secure Sender</h3>
          <div className="form-group">
            <label>DHT Node Address</label>
            <input value={dhtIp} onChange={e => setDhtIp(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Receiver Address</label>
            <input value={receiverIp} onChange={e => setReceiverIp(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Self Destruct Timer (Seconds)</label>
            <input type="range" min="10" max="300" value={ttl} onChange={e => setTtl(e.target.value)} />
            <span>{ttl}s</span>
          </div>
          <textarea 
            placeholder="Enter secret message..." 
            value={message} 
            onChange={e => setMessage(e.target.value)} 
          />
          <button onClick={handleSend} disabled={!message}>Encrypt & Send</button>
        </div>

        {/* RECEIVER PANEL */}
        <div className="card">
          <h3>Secure Inbox</h3>
          <div className="inbox-list">
            {inbox.length === 0 && <p className="empty">No messages received.</p>}
            {inbox.map((msg, i) => (
              <div key={i} className={`msg-item ${msg.status}`}>
                <span className="time">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                <p>{msg.body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="logs">
        <h4>System Logs</h4>
        {logs.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );

  const renderDHT = () => (
    <div className="container dht-theme">
      <div className="header">
        <h1>DHT Storage Node</h1>
        <button onClick={() => setRole('setup')}>Exit</button>
      </div>
      
      <div className="card full-width">
        <h3>Active Key Shares</h3>
        <table>
          <thead>
            <tr>
              <th>Share ID</th>
              <th>Status</th>
              <th>Expires At</th>
              <th>Time Left</th>
            </tr>
          </thead>
          <tbody>
            {dhtData.map(share => {
              const timeLeft = Math.max(0, Math.floor((share.expiresAt - Date.now()) / 1000));
              return (
                <tr key={share.id}>
                  <td>{share.id}</td>
                  <td><span className="badge active">Active</span></td>
                  <td>{new Date(share.expiresAt).toLocaleTimeString()}</td>
                  <td style={{color: timeLeft < 10 ? 'red' : 'inherit', fontWeight: 'bold'}}>
                    {timeLeft}s
                  </td>
                </tr>
              );
            })}
            {dhtData.length === 0 && <tr><td colSpan="4">DHT is empty. Waiting for shares...</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="app-root">
      {role === 'setup' && renderSetup()}
      {role === 'client' && renderClient()}
      {role === 'dht' && renderDHT()}
    </div>
  );
}

export default App;