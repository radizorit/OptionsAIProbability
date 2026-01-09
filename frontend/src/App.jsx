import { useState, useEffect, Fragment } from 'react';
import './App.css';

function App() {
  const [ticker, setTicker] = useState('AAPL');
  const [expirationDate, setExpirationDate] = useState('');
  const [contractType, setContractType] = useState('call');
  const [action, setAction] = useState('buy');
  const [expirationDates, setExpirationDates] = useState([]);
  const [options, setOptions] = useState([]);
  const [underlyingPrice, setUnderlyingPrice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [marketOpen, setMarketOpen] = useState(false);

  // Fetch expiration dates when ticker changes
  useEffect(() => {
    if (ticker) {
      fetchExpirationDates();
    }
  }, [ticker]);

  // Auto-select first expiration date when dates are loaded
  useEffect(() => {
    if (expirationDates.length > 0 && !expirationDate) {
      setExpirationDate(expirationDates[0].date);
    }
  }, [expirationDates, expirationDate]);

  // Fetch options when filters change
  useEffect(() => {
    if (ticker && expirationDate && contractType) {
      fetchOptions();
    }
  }, [ticker, expirationDate, contractType]);

  const fetchExpirationDates = async () => {
    try {
      const response = await fetch(
        `/api/expiration-dates?ticker=${encodeURIComponent(ticker)}`
      );
      if (!response.ok) throw new Error('Failed to fetch expiration dates');
      const data = await response.json();
      setExpirationDates(data.expirationDates || []);
    } catch (err) {
      console.error('Error fetching expiration dates:', err);
      setError(err.message);
    }
  };

  const fetchOptions = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/options?ticker=${encodeURIComponent(ticker)}&expirationDate=${encodeURIComponent(expirationDate)}&contractType=${encodeURIComponent(contractType)}`
      );
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch options');
      }
      const data = await response.json();
      setOptions(data.options || []);
      setUnderlyingPrice(data.underlyingPrice);
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

  const getPriceDisplay = (option) => {
    // Display ask price (or close as fallback)
    return formatCurrency(option.askPrice || option.optionPrice);
  };

  // Find the position where to insert the share price indicator
  const getSharePricePosition = () => {
    if (!underlyingPrice || options.length === 0) return -1;
    
    for (let i = 0; i < options.length; i++) {
      if (options[i].strikePrice > underlyingPrice) {
        return i;
      }
    }
    return options.length;
  };

  const sharePricePosition = getSharePricePosition();

  return (
    <div className="app">
      <div className="container">
        {/* Header */}
        <div className="header">
          <div className="header-left">
            <div className="stock-info">
              {ticker} {underlyingPrice ? `${formatCurrency(underlyingPrice)}` : ''}
              {underlyingPrice && (
                <span className="price-change"> (0.00%)</span>
              )}
            </div>
            <div className="strategy-info">
              {ticker} {action} {contractType}
            </div>
          </div>
          <div className="header-right">
            <button className="price-history-btn">
              Price History <span className="expand-icon">▼</span>
            </button>
          </div>
        </div>

        {/* Controls */}
        <div className="controls">
          <div className="control-group">
            <button
              className={`control-btn ${action === 'buy' ? 'active' : ''}`}
              onClick={() => setAction('buy')}
            >
              <span className="icon">📊</span> Builder
            </button>
            <button
              className={`control-btn ${action === 'buy' ? 'active' : ''}`}
              onClick={() => setAction('buy')}
            >
              Buy
            </button>
            <button
              className={`control-btn ${action === 'sell' ? 'active' : ''}`}
              onClick={() => setAction('sell')}
            >
              Sell
            </button>
          </div>

          <div className="control-group">
            <button
              className={`control-btn ${contractType === 'call' ? 'active' : ''}`}
              onClick={() => setContractType('call')}
            >
              Call
            </button>
            <button
              className={`control-btn ${contractType === 'put' ? 'active' : ''}`}
              onClick={() => setContractType('put')}
            >
              Put
            </button>
          </div>

          <div className="control-group">
            <input
              type="text"
              className="ticker-input"
              placeholder="Ticker (e.g., AAPL)"
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
            />
          </div>

          <div className="control-group">
            <select
              className="expiration-select"
              value={expirationDate}
              onChange={(e) => setExpirationDate(e.target.value)}
            >
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
                          <button className="add-btn">+</button>
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
      </div>
    </div>
  );
}

export default App;
