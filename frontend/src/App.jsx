import { useState, useEffect, Fragment, useRef } from 'react';
import './App.css';

function App() {
  const [ticker, setTicker] = useState('');
  const [debouncedTicker, setDebouncedTicker] = useState('');
  const [expirationDate, setExpirationDate] = useState('');
  const [contractType, setContractType] = useState('call');
  const [action, setAction] = useState('buy');
  const [expirationDates, setExpirationDates] = useState([]);
  const [options, setOptions] = useState([]);
  const [underlyingPrice, setUnderlyingPrice] = useState(null);
  const [underlying, setUnderlying] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [marketOpen, setMarketOpen] = useState(false);
  const tickerInputRef = useRef(null);

  const [chatMessages, setChatMessages] = useState([
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      content:
        'Add a contract to analyze by clicking the "+" button on the option chain.',
      ts: Date.now(),
    },
  ]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const chatEndRef = useRef(null);

  // Auto-focus ticker input on page load
  useEffect(() => {
    if (tickerInputRef.current) {
      tickerInputRef.current.focus();
    }
  }, []);

  // Keep chat scrolled to the latest message
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  // Debounce ticker so we don't spam the backend/Polygon on every keystroke
  useEffect(() => {
    const next = (ticker || '').trim().toUpperCase();
    const handle = setTimeout(() => setDebouncedTicker(next), 450);
    return () => clearTimeout(handle);
  }, [ticker]);

  // Reset dependent state immediately when user edits ticker (before debounce completes)
  useEffect(() => {
    setExpirationDates([]);
    setExpirationDate('');
    setOptions([]);
    setUnderlyingPrice(null);
    setUnderlying(null);
    setError(null);
  }, [ticker]);

  // Fetch expiration dates only after debounce settles
  useEffect(() => {
    if (debouncedTicker) fetchExpirationDates(debouncedTicker);
  }, [debouncedTicker]);

  // Fetch options only when BOTH ticker AND expiration date are selected
  useEffect(() => {
    if (debouncedTicker && expirationDate && contractType) {
      fetchOptions(debouncedTicker);
    } else {
      // Clear options if requirements not met
      setOptions([]);
      setUnderlyingPrice(null);
      setUnderlying(null);
    }
  }, [debouncedTicker, expirationDate, contractType]);

  const fetchExpirationDates = async (t) => {
    setExpirationDates([]); // Clear previous dates immediately
    try {
      const response = await fetch(
        `/api/expiration-dates?ticker=${encodeURIComponent(t)}`
      );
      if (!response.ok) throw new Error('Failed to fetch expiration dates');
      const data = await response.json();
      setExpirationDates(data.expirationDates || []);
    } catch (err) {
      console.error('Error fetching expiration dates:', err);
      setError(err.message);
    }
  };

  const fetchOptions = async (t) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/options?ticker=${encodeURIComponent(t)}&expirationDate=${encodeURIComponent(expirationDate)}&contractType=${encodeURIComponent(contractType)}`
      );
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch options');
      }
      const data = await response.json();
      setOptions(data.options || []);
      setUnderlying(data.underlying || null);
      setUnderlyingPrice((data.underlying && data.underlying.price != null) ? data.underlying.price : data.underlyingPrice);
      setMarketOpen(data.marketOpen || false);
    } catch (err) {
      console.error('Error fetching options:', err);
      setError(err.message);
      setOptions([]);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (value) => {
    if (value === null || value === undefined) return '-';
    return `$${Number(value).toFixed(2)}`;
  };

  const formatPercent = (value) => {
    if (value === null || value === undefined) return '-';
    const sign = value >= 0 ? '+' : '';
    return `${sign}${Number(value).toFixed(2)}%`;
  };

  const formatSignedCurrency = (value) => {
    if (value === null || value === undefined) return '-';
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    const sign = n > 0 ? '+' : '';
    return `${sign}$${Math.abs(n).toFixed(2)}`.replace(`${sign}$`, `${sign}$`);
  };

  const getSignClass = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return 'neutral';
    return n > 0 ? 'positive' : 'negative';
  };

  const computeChange = (current, base) => {
    const c = Number(current);
    const b = Number(base);
    if (!Number.isFinite(c) || !Number.isFinite(b) || b === 0) {
      return { change: null, changePercent: null };
    }
    const change = c - b;
    const changePercent = (change / b) * 100;
    return { change, changePercent };
  };

  const getPriceDisplay = (option) => {
    // Display ask price (or close as fallback)
    return formatCurrency(option.askPrice || option.optionPrice);
  };

  const buildOptionAnalysisPrompt = (option) => {
    const parts = [];

    parts.push(`Option contract selected:`);
    parts.push(`- Underlying: ${ticker || 'N/A'}`);
    parts.push(`- Option ticker: ${option.ticker || 'N/A'}`);
    parts.push(`- Type: ${option.contractType || contractType}`);
    parts.push(`- Expiration: ${option.expirationDate || expirationDate || 'N/A'}`);
    parts.push(`- Strike: ${formatCurrency(option.strikePrice)}`);
    parts.push(`- Bid: ${option.bidPrice != null ? formatCurrency(option.bidPrice) : 'N/A'}`);
    parts.push(`- Ask: ${option.askPrice != null ? formatCurrency(option.askPrice) : 'N/A'}`);
    parts.push(`- Close (fallback): ${option.optionPrice != null ? formatCurrency(option.optionPrice) : 'N/A'}`);
    parts.push(`- Change: ${option.priceChange != null ? formatCurrency(option.priceChange) : 'N/A'} (${option.percentChange != null ? formatPercent(option.percentChange) : 'N/A'})`);
    parts.push(`- Open Interest: ${option.openInterest ?? 'N/A'}`);
    parts.push(`- Volume: ${option.volume ?? 'N/A'}`);
    parts.push(`- IV: ${option.impliedVolatility != null ? `${Number(option.impliedVolatility).toFixed(4)}` : 'N/A'}`);
    parts.push(`- Delta: ${option.delta != null ? Number(option.delta).toFixed(4) : 'N/A'}`);
    parts.push(`- Underlying price: ${underlyingPrice != null ? formatCurrency(underlyingPrice) : 'N/A'}`);
    parts.push('');
    parts.push('Questions:');
    parts.push('a. How likely will this option contract be profitable?');
    parts.push('b. Are there better trades out there that are higher %? (Buy call, sell call, buy put, sell put)');
    parts.push('c. Consider alternatives like: "What if you had SOLD this call instead?" (Selling flips the math, credit collected, win condition, implied probability).');

    return parts.join('\n');
  };

  const onAddOptionToChat = (option) => {
    const prompt = buildOptionAnalysisPrompt(option);
    setChatDraft(prompt);
    setChatMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content: prompt, ts: Date.now() },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          'Draft ready. Edit the questions if you want, then press Send. (Model integration not wired yet.)',
        ts: Date.now(),
      },
    ]);
  };

  const onSendChat = () => {
    const trimmed = chatDraft.trim();
    if (!trimmed || chatSending) return;

    const nextUserMsg = { id: crypto.randomUUID(), role: 'user', content: trimmed, ts: Date.now() };
    setChatMessages((prev) => [...prev, nextUserMsg]);
    setChatDraft('');
    setChatSending(true);

    // Call backend chat endpoint with recent context
    const outgoing = (msgs) =>
      msgs
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }));

    // Use functional update snapshot for best ordering
    setChatMessages((prev) => {
      const payload = outgoing([...prev, nextUserMsg]);
      (async () => {
        try {
          const resp = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: payload }),
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || `Chat error: ${resp.status}`);
          }
          const data = await resp.json();
          const content = data?.content || '(empty response)';
          setChatMessages((p) => [
            ...p,
            { id: crypto.randomUUID(), role: 'assistant', content, ts: Date.now() },
          ]);
        } catch (e) {
          setChatMessages((p) => [
            ...p,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: `Error: ${e.message}`,
              ts: Date.now(),
            },
          ]);
        } finally {
          setChatSending(false);
        }
      })();
      return prev;
    });
  };

  const onClearChat = () => {
    setChatMessages([
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          'Chat cleared. Add a contract to analyze by clicking the "+" button on the option chain.',
        ts: Date.now(),
      },
    ]);
    setChatDraft('');
  };

  // Find the position where to insert the share price indicator
  // Since we're showing descending order (highest first), we need to find
  // the first strike that is below the share price
  const getSharePricePosition = () => {
    if (!underlyingPrice || options.length === 0) return -1;

    // Options are sorted descending (highest first)
    // Find the first strike that is below the share price
    for (let i = 0; i < options.length; i++) {
      if (options[i].strikePrice < underlyingPrice) {
        return i;
      }
    }
    // If all strikes are above share price, put it at the end
    return options.length;
  };

  const sharePricePosition = getSharePricePosition();

  return (
    <div className="app">
      <div className="container">
        {/* Title */}
        <div className="app-title">
          <h1>FormosaOps</h1>
        </div>

        {/* Header */}
        <div className="header">
          <div className="header-left">
            <div className="header-input-group">
              <input
                id="ticker-input"
                ref={tickerInputRef}
                type="text"
                className="ticker-input"
                placeholder="Enter ticker (e.g., AAPL)"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
              />
              {ticker && underlying?.price != null && (
                <div className="stock-price-info">
                  <div className="stock-price-main">
                    {formatCurrency(underlying.price)}
                  </div>
                  <div className="stock-price-sub">
                    {underlying.todayChange == null && underlying.overnightChange == null && underlying.prevClose != null && (
                      (() => {
                        const { change, changePercent } = computeChange(underlying.price, underlying.prevClose);
                        if (change == null || changePercent == null) return null;
                        return (
                          <div className="change-row">
                            <span className={getSignClass(change)}>
                              {formatSignedCurrency(change)} ({formatPercent(changePercent)})
                            </span>
                            <span className="change-label">Change</span>
                          </div>
                        );
                      })()
                    )}
                    {underlying.todayChange != null && underlying.todayChangePercent != null && (
                      <div className="change-row">
                        <span className={getSignClass(underlying.todayChange)}>
                          {formatSignedCurrency(underlying.todayChange)} ({formatPercent(underlying.todayChangePercent)})
                        </span>
                        <span className="change-label">Today</span>
                      </div>
                    )}
                    {underlying.overnightChange != null && underlying.overnightChangePercent != null && (
                      <div className="change-row">
                        <span className={getSignClass(underlying.overnightChange)}>
                          {formatSignedCurrency(underlying.overnightChange)} ({formatPercent(underlying.overnightChangePercent)})
                        </span>
                        <span className="change-label">Overnight</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="header-right">
            <button type="button" className="price-history-btn">
              Price History <span className="expand-icon">▼</span>
            </button>
          </div>
        </div>

        {/* Controls */}
        <div className="controls">
          <div className="control-group">
            <button
              type="button"
              className={`control-btn ${action === 'buy' ? 'active' : ''}`}
              onClick={() => setAction('buy')}
            >
              Buy
            </button>
            <button
              type="button"
              className={`control-btn ${action === 'sell' ? 'active' : ''}`}
              onClick={() => setAction('sell')}
            >
              Sell
            </button>
          </div>

          <div className="control-group">
            <button
              type="button"
              className={`control-btn ${contractType === 'call' ? 'active' : ''}`}
              onClick={() => setContractType('call')}
            >
              Call
            </button>
            <button
              type="button"
              className={`control-btn ${contractType === 'put' ? 'active' : ''}`}
              onClick={() => setContractType('put')}
            >
              Put
            </button>
          </div>


          <div className="control-group">
            <select
              className="expiration-select"
              value={expirationDate}
              onChange={(e) => setExpirationDate(e.target.value)}
              disabled={!ticker || expirationDates.length === 0}
            >
              <option value="">Select expiration date...</option>
              {expirationDates.map((date) => (
                <option key={date.date} value={date.date}>
                  Expiring {date.formatted} ({date.daysUntil}d)
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="error-message">
            Error: {error}
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="loading">
            Loading options data...
          </div>
        )}

        {/* Options Table */}
        {!loading && options.length > 0 && (
          <div className="options-table-container">
            <table className="options-table">
              <thead>
                <tr>
                  <th>Strike price</th>
                  <th>Breakeven</th>
                  <th>To breakeven</th>
                  <th>% Change</th>
                  <th>Change</th>
                  <th>Ask Price</th>
                </tr>
              </thead>
              <tbody>
                {options.map((option, index) => (
                  <Fragment key={option.ticker}>
                    {index === sharePricePosition && underlyingPrice && (
                      <tr className="share-price-row">
                        <td colSpan="6" className="share-price-indicator">
                          <div className="share-price-line"></div>
                          <div className="share-price-label">
                            Share price: {formatCurrency(underlyingPrice)}
                          </div>
                        </td>
                      </tr>
                    )}
                    <tr>
                      <td>{formatCurrency(option.strikePrice)}</td>
                      <td>{formatCurrency(option.breakeven)}</td>
                      <td>{formatPercent(option.toBreakeven)}</td>
                      <td className={option.percentChange < 0 ? 'negative' : 'positive'}>
                        {formatPercent(option.percentChange)}
                      </td>
                      <td className={option.priceChange < 0 ? 'negative' : 'positive'}>
                        {formatCurrency(option.priceChange)}
                      </td>
                      <td>
                        <div className="price-cell">
                          {getPriceDisplay(option)}
                          <button
                            type="button"
                            className="add-btn"
                            onClick={() => onAddOptionToChat(option)}
                            aria-label={`Add ${option.contractType} ${option.expirationDate} ${option.strikePrice} to chat`}
                          >
                            +
                          </button>
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                ))}
                {sharePricePosition === options.length && underlyingPrice && (
                  <tr className="share-price-row">
                    <td colSpan="6" className="share-price-indicator">
                      <div className="share-price-line"></div>
                      <div className="share-price-label">
                        Share price: {formatCurrency(underlyingPrice)}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && options.length === 0 && expirationDate && (
          <div className="no-data">
            No options found for the selected criteria.
          </div>
        )}

        {/* Chatbox */}
        <div className="chatbox">
          <div className="chatbox-header">
            <div className="chatbox-title">Chat</div>
            <button type="button" className="chatbox-clear" onClick={onClearChat}>
              Clear
            </button>
          </div>

          <div className="chatbox-messages" role="log" aria-live="polite">
            {chatMessages.map((m) => (
              <div key={m.id} className={`chatmsg chatmsg-${m.role}`}>
                <div className="chatmsg-role">{m.role}</div>
                <pre className="chatmsg-content">{m.content}</pre>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <div className="chatbox-input">
            <textarea
              className="chatbox-textarea"
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              placeholder='Click "+" on a contract to populate details here…'
              rows={6}
              disabled={chatSending}
            />
            <div className="chatbox-actions">
              <button type="button" className="chatbox-send" onClick={onSendChat} disabled={chatSending}>
                {chatSending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
