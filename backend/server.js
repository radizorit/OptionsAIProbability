import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length > 0) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Minimal in-memory rate limit for chat (per process)
const chatRate = new Map(); // ip -> { count, resetAtMs }
function chatRateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  const windowMs = 60_000;
  const max = 20; // 20 req/min per IP (tweak as needed)
  const entry = chatRate.get(ip) || { count: 0, resetAtMs: now + windowMs };
  if (now > entry.resetAtMs) {
    entry.count = 0;
    entry.resetAtMs = now + windowMs;
  }
  entry.count += 1;
  chatRate.set(ip, entry);
  if (entry.count > max) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please wait a minute and try again.' });
  }
  next();
}

// Helper function to check if market is open (9:30 AM - 4:00 PM ET, Mon-Fri)
function isMarketOpen() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday
  const hours = now.getHours();
  const minutes = now.getMinutes();

  // Check if it's a weekday (Monday = 1, Friday = 5)
  if (day === 0 || day === 6) return false;

  // Convert to ET (approximation - in production, use proper timezone library)
  // For simplicity, assuming server is in ET or adjust accordingly
  const timeET = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(timeET);
  const etHours = etDate.getHours();
  const etMinutes = etDate.getMinutes();
  const totalMinutes = etHours * 60 + etMinutes;

  // Market hours: 9:30 AM (570 minutes) to 4:00 PM (960 minutes) ET
  return totalMinutes >= 570 && totalMinutes < 960;
}

// Get option price for calculations (bid if market open, close as fallback)
function getOptionPrice(day, marketOpen) {
  if (marketOpen && day.bid !== undefined && day.bid !== null) {
    return day.bid;
  }
  return day.close || 0;
}

// Calculate breakeven for call option
function calculateBreakevenCall(strikePrice, optionPrice) {
  return strikePrice + optionPrice;
}

// Calculate breakeven for put option
function calculateBreakevenPut(strikePrice, optionPrice) {
  return strikePrice - optionPrice;
}

// Calculate percentage change
function calculatePercentChange(current, previous) {
  if (!previous || previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

// Calculate "to breakeven" percentage
function calculateToBreakeven(currentPrice, breakevenPrice) {
  if (!currentPrice || currentPrice === 0) return 0;
  return ((breakevenPrice - currentPrice) / currentPrice) * 100;
}

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function computeChange(current, base) {
  const c = safeNumber(current);
  const b = safeNumber(base);
  if (c === null || b === null) return { change: null, changePercent: null };
  const change = c - b;
  const changePercent = b === 0 ? null : (change / b) * 100;
  return { change, changePercent };
}

async function fetchUnderlying(ticker, apiKey) {
  // Prefer the stock snapshot endpoint because it provides prevDay/day/lastTrade in one call.
  // https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}
  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${apiKey}`;
  const res = await fetch(url);
  const marketOpen = isMarketOpen();

  // Many Polygon plans are not entitled to the snapshot endpoint. If so, fall back to prev close.
  if (!res.ok) {
    const text = await res.text().catch(() => '');

    // Fallback: previous day's aggregate close (commonly entitled).
    // https://api.polygon.io/v2/aggs/ticker/{ticker}/prev
    const prevUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?apiKey=${apiKey}`;
    const prevRes = await fetch(prevUrl);
    if (!prevRes.ok) {
      const prevText = await prevRes.text().catch(() => '');
      throw new Error(
        `Polygon underlying error: snapshot ${res.status}${text ? ` - ${text}` : ''}; prev ${prevRes.status}${prevText ? ` - ${prevText}` : ''}`
      );
    }
    const prevData = await prevRes.json();
    const prevClose = safeNumber(prevData?.results?.[0]?.c);
    return {
      ticker,
      marketOpen,
      prevClose,
      dayClose: null,
      lastTrade: null,
      price: prevClose,
      todayChange: null,
      todayChangePercent: null,
      overnightChange: null,
      overnightChangePercent: null,
      source: `polygon_prev_v2_fallback_from_snapshot_${res.status}`,
    };
  }

  const data = await res.json();
  const t = data?.ticker;

  const prevClose = safeNumber(t?.prevDay?.c);
  const dayClose = safeNumber(t?.day?.c);
  const lastTrade = safeNumber(t?.lastTrade?.p);

  // Price heuristic:
  // - During market hours, prefer lastTrade if available.
  // - Outside market hours, prefer lastTrade if it differs from dayClose (after-hours), else dayClose.
  // - Fallback to prevClose.
  let price = null;
  if (lastTrade !== null && (marketOpen || (dayClose !== null && lastTrade !== dayClose))) {
    price = lastTrade;
  } else if (dayClose !== null) {
    price = dayClose;
  } else if (prevClose !== null) {
    price = prevClose;
  }

  // Robinhood-style breakdown approximation:
  // - Today: regular session move = dayClose - prevClose
  // - Overnight: after-hours move = lastTrade - dayClose
  const todayMove = computeChange(dayClose, prevClose);
  const overnightMove = computeChange(lastTrade, dayClose);

  return {
    ticker,
    marketOpen,
    prevClose,
    dayClose,
    lastTrade,
    price,
    todayChange: todayMove.change,
    todayChangePercent: todayMove.changePercent,
    overnightChange: overnightMove.change,
    overnightChangePercent: overnightMove.changePercent,
    source: 'polygon_snapshot_v2',
  };
}

// API endpoint to get options chain
app.get('/api/options', async (req, res) => {
  try {
    const { ticker, expirationDate, contractType } = req.query;

    if (!ticker || !expirationDate || !contractType) {
      return res.status(400).json({
        error: 'Missing required parameters: ticker, expirationDate, contractType'
      });
    }

    const API_KEY = process.env.POLYGON_API_KEY;
    if (!API_KEY) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    // Fetch underlying snapshot (price + today/overnight breakdown)
    const underlying = await fetchUnderlying(ticker, API_KEY);
    const marketOpen = underlying.marketOpen;
    const underlyingPrice = underlying.price;

    // Use the contracts endpoint to get ALL available strikes for this expiration
    // This gives us all strikes, not just ones with recent activity
    const contractsUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}&expiration_date=${expirationDate}&contract_type=${contractType}&limit=1000&apiKey=${API_KEY}`;

    let contractsResponse = await fetch(contractsUrl);
    let allContracts = [];
    let filteredOptions = [];

    if (contractsResponse.ok) {
      const contractsData = await contractsResponse.json();

      if (contractsData.results && contractsData.results.length > 0) {
        allContracts = contractsData.results;
        const allStrikes = allContracts.map(c => c.strike_price).sort((a, b) => a - b);

        // If we have underlying price, filter to strikes around it
        if (underlyingPrice) {
          const strikesBelow = allStrikes.filter(s => s < underlyingPrice).sort((a, b) => b - a);
          const strikesAtOrAbove = allStrikes.filter(s => s >= underlyingPrice).sort((a, b) => a - b);

          const selectedBelow = strikesBelow.slice(0, 10);
          const selectedAbove = strikesAtOrAbove.slice(0, 10);
          const targetStrikes = [...selectedBelow, ...selectedAbove].sort((a, b) => a - b);

          // Filter contracts to only those with target strikes
          allContracts = allContracts.filter(c => targetStrikes.includes(c.strike_price));
        }
      }
    }

    // Now fetch snapshot data (pricing) - filter by expiration + type to reduce pagination
    // The snapshot endpoint uses pagination with next_url cursor
    const polygonUrl =
      `https://api.polygon.io/v3/snapshot/options/${ticker}` +
      `?expiration_date=${encodeURIComponent(expirationDate)}` +
      `&contract_type=${encodeURIComponent(contractType)}` +
      `&limit=250` +
      `&apiKey=${API_KEY}`;

    let allSnapshotResults = [];
    let nextUrl = polygonUrl;
    let pageCount = 0;
    const maxPages = 30; // Safety limit to prevent infinite loops (we're already filtered)

    // Determine target strikes if we have underlying price and contracts
    let targetStrikesSet = null;
    if (underlyingPrice && allContracts.length > 0) {
      const allStrikes = allContracts.map(c => c.strike_price);
      const strikesBelow = allStrikes.filter(s => s < underlyingPrice).sort((a, b) => b - a);
      const strikesAtOrAbove = allStrikes.filter(s => s >= underlyingPrice).sort((a, b) => a - b);
      const selectedBelow = strikesBelow.slice(0, 10);
      const selectedAbove = strikesAtOrAbove.slice(0, 10);
      const targetStrikes = [...selectedBelow, ...selectedAbove];
      targetStrikesSet = new Set(targetStrikes);
    }

    // Paginate through results, but stop early if we have all target strikes
    while (nextUrl && pageCount < maxPages) {
      pageCount++;

      // Ensure API key is in the URL (next_url from Polygon doesn't include the API key)
      let urlToFetch = nextUrl;
      if (!urlToFetch.includes('apiKey=')) {
        const separator = urlToFetch.includes('?') ? '&' : '?';
        urlToFetch = `${urlToFetch}${separator}apiKey=${API_KEY}`;
      }

      const response = await fetch(urlToFetch);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Error fetching options snapshot:', errorText);
        throw new Error(`Polygon API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      if (data.results && data.results.length > 0) {
        allSnapshotResults = allSnapshotResults.concat(data.results);

        // Check if we have all target strikes (if we're filtering by target strikes)
        if (targetStrikesSet) {
          const relevantResults = allSnapshotResults.filter(opt => {
            return opt.details.expiration_date === expirationDate &&
              opt.details.contract_type.toLowerCase() === contractType.toLowerCase() &&
              targetStrikesSet.has(opt.details.strike_price);
          });

          const foundStrikes = new Set(relevantResults.map(r => r.details.strike_price));
          const missingStrikes = [...targetStrikesSet].filter(s => !foundStrikes.has(s));

          if (missingStrikes.length === 0) {
            nextUrl = null; // Stop pagination
            break;
          }
        }
      }

      // Check for next page
      if (data.next_url && nextUrl) {
        nextUrl = data.next_url;
      } else {
        nextUrl = null;
      }
    }

    // Use the paginated results
    let data = { results: allSnapshotResults };

    if (data.results && data.results.length > 0) {
      // If we have target contracts from the contracts endpoint, filter by those tickers
      // Otherwise, fall back to filtering by expiration date and contract type
      if (allContracts.length > 0) {
        const targetTickers = new Set(allContracts.map(c => c.ticker));

        filteredOptions = data.results.filter(option => {
          return targetTickers.has(option.details.ticker);
        });
      } else {
        // Fallback: filter by expiration date and contract type
        filteredOptions = data.results.filter(option => {
          const optionExpiration = option.details.expiration_date;
          const optionType = option.details.contract_type.toLowerCase();

          return optionExpiration === expirationDate &&
            optionType === contractType.toLowerCase();
        });
      }
    }

    if (filteredOptions.length === 0) {
      return res.json({
        options: [],
        underlyingPrice,
        marketOpen
      });
    }

    // Process and enrich option data
    const enrichedOptions = filteredOptions.map(option => {
      const strikePrice = option.details.strike_price;
      // Use bid if market open for calculations, otherwise close
      const optionPrice = getOptionPrice(option.day, marketOpen);
      // For display: ask price (or close as fallback)
      const askPrice = option.day.ask !== undefined && option.day.ask !== null
        ? option.day.ask
        : option.day.close || 0;
      const bidPrice = option.day.bid !== undefined && option.day.bid !== null
        ? option.day.bid
        : null;
      const previousClose = option.day.previous_close || 0;
      const priceChange = optionPrice - previousClose;
      const percentChange = calculatePercentChange(optionPrice, previousClose);

      // Calculate breakeven based on contract type (using option price for calculations)
      let breakeven = 0;
      if (contractType.toLowerCase() === 'call') {
        breakeven = calculateBreakevenCall(strikePrice, optionPrice);
      } else {
        breakeven = calculateBreakevenPut(strikePrice, optionPrice);
      }

      // Calculate "to breakeven" with underlying price if available
      let toBreakeven = 0;
      if (underlyingPrice) {
        toBreakeven = calculateToBreakeven(underlyingPrice, breakeven);
      }

      return {
        strikePrice,
        optionPrice,
        askPrice,
        bidPrice,
        breakeven,
        toBreakeven,
        priceChange,
        percentChange,
        open: option.day.open || 0,
        high: option.day.high || 0,
        low: option.day.low || 0,
        volume: option.day.volume || 0,
        openInterest: option.open_interest || 0,
        impliedVolatility: option.implied_volatility || 0,
        delta: option.greeks?.delta || 0,
        gamma: option.greeks?.gamma || 0,
        theta: option.greeks?.theta || 0,
        vega: option.greeks?.vega || 0,
        ticker: option.details.ticker,
        expirationDate: option.details.expiration_date,
        contractType: option.details.contract_type,
      };
    });

    // Sort by strike price descending (highest first)
    enrichedOptions.sort((a, b) => b.strikePrice - a.strikePrice);

    // Filter to show 10 strikes above and 10 strikes below the market price
    let filteredEnrichedOptions = enrichedOptions;
    if (underlyingPrice && enrichedOptions.length > 0) {
      // Check if available strikes are far from market price
      const minStrike = Math.min(...enrichedOptions.map(o => o.strikePrice));
      const maxStrike = Math.max(...enrichedOptions.map(o => o.strikePrice));
      const strikeRange = maxStrike - minStrike;
      const priceDiff = Math.max(
        Math.abs(underlyingPrice - minStrike),
        Math.abs(underlyingPrice - maxStrike)
      );


      // Separate strikes into those below and above the market price
      const strikesBelow = enrichedOptions.filter(opt => opt.strikePrice < underlyingPrice);
      const strikesAtOrAbove = enrichedOptions.filter(opt => opt.strikePrice >= underlyingPrice);

      // Sort below strikes descending (highest first) and above strikes ascending (lowest first)
      strikesBelow.sort((a, b) => b.strikePrice - a.strikePrice);
      strikesAtOrAbove.sort((a, b) => a.strikePrice - b.strikePrice);

      // Take up to 10 strikes below market price (closest to market price)
      const selectedBelow = strikesBelow.slice(0, 10);
      // Take up to 10 strikes at or above market price (closest to market price)
      const selectedAbove = strikesAtOrAbove.slice(0, 10);

      // Combine and sort by strike price descending (highest first)
      filteredEnrichedOptions = [...selectedBelow, ...selectedAbove].sort((a, b) => b.strikePrice - a.strikePrice);
    }

    res.json({
      options: filteredEnrichedOptions,
      underlyingPrice,
      underlying,
      marketOpen,
    });

  } catch (error) {
    console.error('Error fetching options:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to get available expiration dates for a ticker
app.get('/api/expiration-dates', async (req, res) => {
  try {
    const { ticker } = req.query;

    if (!ticker) {
      return res.status(400).json({ error: 'Missing required parameter: ticker' });
    }

    const API_KEY = process.env.POLYGON_API_KEY;
    if (!API_KEY) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    // Use the contracts endpoint to get ALL available expiration dates
    // This endpoint lists all contracts regardless of activity, giving us comprehensive date coverage
    const contractsUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}&limit=1000&apiKey=${API_KEY}`;
    let expirationDatesSet = new Set();
    let nextUrl = contractsUrl;
    let pageCount = 0;
    const maxPages = 100; // Paginate through contracts to get all dates

    // Paginate through all contracts to collect every unique expiration date
    while (nextUrl && pageCount < maxPages) {
      pageCount++;

      let urlToFetch = nextUrl;
      if (!urlToFetch.includes('apiKey=')) {
        const separator = urlToFetch.includes('?') ? '&' : '?';
        urlToFetch = `${urlToFetch}${separator}apiKey=${API_KEY}`;
      }

      const response = await fetch(urlToFetch);

      if (!response.ok) {
        throw new Error(`Polygon API error: ${response.status}`);
      }

      const data = await response.json();

      if (data.results && data.results.length > 0) {
        // Extract expiration dates from contracts
        data.results.forEach(contract => {
          if (contract.expiration_date) {
            expirationDatesSet.add(contract.expiration_date);
          }
        });
      }

      if (data.next_url) {
        nextUrl = data.next_url;
      } else {
        nextUrl = null;
      }
    }

    // Use the Set we built during pagination
    if (expirationDatesSet.size === 0) {
      return res.json({ expirationDates: [] });
    }

    const expirationDates = Array.from(expirationDatesSet).sort();

    // Format dates and calculate days until expiration
    const formattedDates = expirationDates.map(date => {
      // Parse date string (format: YYYY-MM-DD) and create Date object in UTC to avoid timezone issues
      const [year, month, day] = date.split('-').map(Number);
      const expirationDate = new Date(Date.UTC(year, month - 1, day));
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      today.setUTCHours(0, 0, 0, 0);
      const daysUntil = Math.ceil((expirationDate - today) / (1000 * 60 * 60 * 24));

      return {
        date,
        formatted: expirationDate.toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC'
        }),
        daysUntil,
      };
    });

    res.json({ expirationDates: formattedDates });

  } catch (error) {
    console.error('Error fetching expiration dates:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat', chatRateLimit, async (req, res) => {
  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        error: 'OPENAI_API_KEY is not configured on the server.',
      });
    }

    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const { messages } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Missing required field: messages[]' });
    }

    // Keep payload small and predictable
    const trimmed = messages
      .filter((m) => m && typeof m.role === 'string' && typeof m.content === 'string')
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));

    const system = {
      role: 'system',
      content:
        'You are an options analysis assistant. Be concise, quantify assumptions, and show calculations. ' +
        'Provide a short disclaimer that this is not financial advice. ' +
        'When asked, compare buy vs sell of the same contract (credit vs debit, win condition, breakeven) and estimate an implied probability using available context.',
    };

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [system, ...trimmed],
        temperature: 0.4,
      }),
    });

    if (!openaiRes.ok) {
      const text = await openaiRes.text().catch(() => '');
      return res.status(502).json({
        error: `OpenAI error: ${openaiRes.status}${text ? ` - ${text}` : ''}`,
      });
    }

    const data = await openaiRes.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    return res.json({ content });
  } catch (error) {
    console.error('Error in /api/chat:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
