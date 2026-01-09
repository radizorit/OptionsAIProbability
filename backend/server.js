import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

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

    // First, fetch underlying price to determine which strikes we need
    const marketOpen = isMarketOpen();
    let underlyingPrice = null;
    try {
      const underlyingUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?apiKey=${API_KEY}`;
      console.log('\n=== Fetching Underlying Price First ===');
      console.log(`curl -X GET "${underlyingUrl}"`);

      const quoteResponse = await fetch(underlyingUrl);
      if (quoteResponse.ok) {
        const quoteData = await quoteResponse.json();
        if (quoteData.results && quoteData.results.length > 0) {
          if (marketOpen && quoteData.results[0].bp !== undefined && quoteData.results[0].bp !== null) {
            underlyingPrice = quoteData.results[0].bp;
          } else {
            underlyingPrice = quoteData.results[0].c;
          }
          console.log(`Underlying price: ${underlyingPrice}`);
        }
      }

      // Fallback: try the snapshot endpoint if prev didn't work
      if (!underlyingPrice) {
        const snapshotResponse = await fetch(
          `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${API_KEY}`
        );
        if (snapshotResponse.ok) {
          const snapshotData = await snapshotResponse.json();
          if (snapshotData.ticker?.lastQuote) {
            const quote = snapshotData.ticker.lastQuote;
            if (marketOpen && quote.bp) {
              underlyingPrice = quote.bp;
            } else if (snapshotData.ticker.day?.c) {
              underlyingPrice = snapshotData.ticker.day.c;
            }
          }
        }
      }
    } catch (error) {
      console.error('Error fetching underlying price:', error);
    }

    // Use the contracts endpoint to get ALL available strikes for this expiration
    // This gives us all strikes, not just ones with recent activity
    const contractsUrl = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}&expiration_date=${expirationDate}&contract_type=${contractType}&limit=1000&apiKey=${API_KEY}`;

    console.log('\n=== Polygon Contracts API Request (All Strikes) ===');
    console.log(`curl -X GET "${contractsUrl}"`);
    console.log('===================================================\n');

    let contractsResponse = await fetch(contractsUrl);
    let allContracts = [];
    let filteredOptions = [];

    if (contractsResponse.ok) {
      const contractsData = await contractsResponse.json();
      console.log('\n=== Contracts API Response ===');
      console.log(`Status: ${contractsResponse.status}`);
      console.log(`Total contracts: ${contractsData.results ? contractsData.results.length : 0}`);

      if (contractsData.results && contractsData.results.length > 0) {
        allContracts = contractsData.results;
        console.log(`\nAll available strikes from contracts endpoint:`);
        const allStrikes = allContracts.map(c => c.strike_price).sort((a, b) => a - b);
        console.log(`Strikes: ${allStrikes.join(', ')}`);
        console.log(`Total strikes: ${allStrikes.length}`);
        console.log(`Range: ${allStrikes[0]} to ${allStrikes[allStrikes.length - 1]}`);

        // If we have underlying price, filter to strikes around it
        if (underlyingPrice) {
          const strikesBelow = allStrikes.filter(s => s < underlyingPrice).sort((a, b) => b - a);
          const strikesAtOrAbove = allStrikes.filter(s => s >= underlyingPrice).sort((a, b) => a - b);

          const selectedBelow = strikesBelow.slice(0, 10);
          const selectedAbove = strikesAtOrAbove.slice(0, 10);
          const targetStrikes = [...selectedBelow, ...selectedAbove].sort((a, b) => a - b);

          console.log(`\nTarget strikes around ${underlyingPrice}: ${targetStrikes.join(', ')}`);

          // Filter contracts to only those with target strikes
          allContracts = allContracts.filter(c => targetStrikes.includes(c.strike_price));
          console.log(`Filtered to ${allContracts.length} contracts with target strikes`);
        }
      }
      console.log('============================\n');
    } else {
      console.log(`Contracts API returned status ${contractsResponse.status}`);
    }

    // Now fetch snapshot data - we need to paginate through all results
    // The snapshot endpoint uses pagination with next_url cursor
    const polygonUrl = `https://api.polygon.io/v3/snapshot/options/${ticker}?apiKey=${API_KEY}`;

    console.log('\n=== Polygon Snapshot API Request (For Pricing Data) ===');
    console.log(`curl -X GET "${polygonUrl}"`);
    console.log('==========================================================\n');

    let allSnapshotResults = [];
    let nextUrl = polygonUrl;
    let pageCount = 0;
    const maxPages = 100; // Safety limit to prevent infinite loops

    // Paginate through all results
    while (nextUrl && pageCount < maxPages) {
      pageCount++;
      console.log(`Fetching page ${pageCount}...`);

      // Ensure API key is in the URL (next_url from Polygon doesn't include the API key)
      let urlToFetch = nextUrl;
      if (!urlToFetch.includes('apiKey=')) {
        // If next_url doesn't have API key, append it
        const separator = urlToFetch.includes('?') ? '&' : '?';
        urlToFetch = `${urlToFetch}${separator}apiKey=${API_KEY}`;
        console.log(`  Added API key to next_url`);
      }

      console.log(`  Fetching: ${urlToFetch.substring(0, 150)}...`);

      const response = await fetch(urlToFetch);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`  Error response: ${errorText}`);
        throw new Error(`Polygon API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      if (data.results && data.results.length > 0) {
        allSnapshotResults = allSnapshotResults.concat(data.results);
        console.log(`  Page ${pageCount}: Got ${data.results.length} results (total so far: ${allSnapshotResults.length})`);
      }

      // Check for next page
      if (data.next_url) {
        nextUrl = data.next_url;
        console.log(`  Has next page, continuing...`);
      } else {
        console.log(`  No more pages. Total results: ${allSnapshotResults.length}`);
        nextUrl = null;
      }
    }

    console.log(`\nFinished pagination. Total options fetched: ${allSnapshotResults.length}\n`);

    // Use the paginated results
    let data = { results: allSnapshotResults };

    // Log full response structure
    console.log('\n=== Polygon API Response (All Paginated Results) ===');
    console.log(`Total results after pagination: ${data.results ? data.results.length : 0}`);

    if (data.results && data.results.length > 0) {
      console.log(`\nFirst option sample (full object):`);
      console.log(JSON.stringify(data.results[0], null, 2));

      // Log all unique expiration dates
      const expirationDates = [...new Set(data.results.map(o => o.details.expiration_date))].sort();
      console.log(`\nAvailable expiration dates in response: ${expirationDates.join(', ')}`);

      // Log all unique strikes for the requested expiration
      const optionsForExpiration = data.results.filter(o =>
        o.details.expiration_date === expirationDate
      );
      if (optionsForExpiration.length > 0) {
        const strikes = [...new Set(optionsForExpiration.map(o => o.details.strike_price))].sort((a, b) => a - b);
        console.log(`\nAll strikes for expiration ${expirationDate}: ${strikes.join(', ')}`);
        console.log(`Strike range: ${strikes[0]} to ${strikes[strikes.length - 1]} (${strikes.length} total)`);
      }
    }
    console.log('=====================================================\n');

    if (data.results && data.results.length > 0) {
      console.log(`Total options returned from Polygon snapshot: ${data.results.length}`);

      // If we have target contracts from the contracts endpoint, filter by those tickers
      // Otherwise, fall back to filtering by expiration date and contract type
      if (allContracts.length > 0) {
        const targetTickers = new Set(allContracts.map(c => c.ticker));
        console.log(`\nFiltering snapshot data to match ${targetTickers.size} target contracts...`);

        filteredOptions = data.results.filter(option => {
          return targetTickers.has(option.details.ticker);
        });

        console.log(`Found ${filteredOptions.length} matching options in snapshot data`);

        // If we didn't find all contracts in snapshot, we might need to fetch their previous close data
        if (filteredOptions.length < allContracts.length) {
          console.log(`\n⚠️  Warning: Only found ${filteredOptions.length} of ${allContracts.length} target contracts in snapshot.`);
          console.log(`   Some strikes may not have recent activity. We'll use what's available.`);
        }
      } else {
        // Fallback: filter by expiration date and contract type
        filteredOptions = data.results.filter(option => {
          const optionExpiration = option.details.expiration_date;
          const optionType = option.details.contract_type.toLowerCase();

          return optionExpiration === expirationDate &&
            optionType === contractType.toLowerCase();
        });
      }

      console.log(`Options after filtering by expiration ${expirationDate} and type ${contractType}: ${filteredOptions.length}`);

      // Log detailed info about filtered options - sort by strike price ascending
      if (filteredOptions.length > 0) {
        // Sort by strike price descending for logging
        filteredOptions.sort((a, b) => b.details.strike_price - a.details.strike_price);

        const strikes = filteredOptions.map(o => o.details.strike_price);
        console.log(`Available strikes from snapshot: ${strikes[0]} to ${strikes[strikes.length - 1]}`);
        console.log(`\n=== Filtered Options Chain Results (Sorted Ascending by Strike) ===`);
        filteredOptions.forEach((option, index) => {
          console.log(`\nOption ${index + 1} - Strike ${option.details.strike_price}:`);
          console.log(`  Ticker: ${option.details.ticker}`);
          console.log(`  Expiration: ${option.details.expiration_date}`);
          console.log(`  Type: ${option.details.contract_type}`);
          console.log(`\n  === ALL PRICE DATA (for comparison with Robinhood) ===`);
          console.log(`  day.close: ${option.day?.close ?? 'N/A'}`);
          console.log(`  day.bid: ${option.day?.bid ?? 'N/A'}`);
          console.log(`  day.ask: ${option.day?.ask ?? 'N/A'}`);
          console.log(`  day.open: ${option.day?.open ?? 'N/A'}`);
          console.log(`  day.high: ${option.day?.high ?? 'N/A'}`);
          console.log(`  day.low: ${option.day?.low ?? 'N/A'}`);
          console.log(`  day.last: ${option.day?.last ?? 'N/A'}`);
          console.log(`  day.previous_close: ${option.day?.previous_close ?? 'N/A'}`);
          console.log(`  day.vwap: ${option.day?.vwap ?? 'N/A'}`);
          // Check if there are any other price fields
          if (option.day) {
            const allDayKeys = Object.keys(option.day);
            const priceKeys = allDayKeys.filter(k =>
              !['change', 'change_percent', 'volume', 'last_updated'].includes(k)
            );
            console.log(`  Other day fields: ${priceKeys.join(', ')}`);
          }
          console.log(`  ================================================`);
          console.log(`  Volume: ${option.day?.volume || 0}`);
          console.log(`  Open Interest: ${option.open_interest || 0}`);
          console.log(`  IV: ${option.implied_volatility || 'N/A'}`);
          console.log(`  Delta: ${option.greeks?.delta || 'N/A'}`);
        });
        console.log('\n=== End Filtered Options ===\n');
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

    console.log(`\n=== Final Enriched Options (Sorted Ascending by Strike) ===`);
    enrichedOptions.forEach((opt, idx) => {
      console.log(`\nStrike ${opt.strikePrice}:`);
      console.log(`  optionPrice (used for calc): ${opt.optionPrice}`);
      console.log(`  askPrice (display): ${opt.askPrice}`);
      console.log(`  bidPrice: ${opt.bidPrice ?? 'N/A'}`);
      console.log(`  open: ${opt.open}`);
      console.log(`  high: ${opt.high}`);
      console.log(`  low: ${opt.low}`);
    });
    console.log('===========================================================\n');

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

      if (priceDiff > 50) {
        console.warn(`⚠️  WARNING: Market price (${underlyingPrice}) is far from available strikes (${minStrike}-${maxStrike})`);
        console.warn(`   Polygon snapshot may only return strikes with recent activity.`);
        console.warn(`   Consider selecting a different expiration date that has strikes near the current price.`);
      }

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

      console.log(`Filtered options: showing ${filteredEnrichedOptions.length} strikes around market price ${underlyingPrice}`);
      console.log(`  - ${selectedBelow.length} strikes below: ${selectedBelow.map(o => o.strikePrice).join(', ')}`);
      console.log(`  - ${selectedAbove.length} strikes at/above: ${selectedAbove.map(o => o.strikePrice).join(', ')}`);
    } else {
      console.log(`No underlying price available or no options found. Showing all ${enrichedOptions.length} options.`);
    }

    res.json({
      options: filteredEnrichedOptions,
      underlyingPrice,
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

    const response = await fetch(
      `https://api.polygon.io/v3/snapshot/options/${ticker}?apiKey=${API_KEY}`
    );

    if (!response.ok) {
      throw new Error(`Polygon API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      return res.json({ expirationDates: [] });
    }

    // Extract unique expiration dates and sort them
    const expirationDates = [...new Set(
      data.results.map(option => option.details.expiration_date)
    )].sort();

    // Format dates and calculate days until expiration
    const formattedDates = expirationDates.map(date => {
      const expirationDate = new Date(date + 'T00:00:00');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const daysUntil = Math.ceil((expirationDate - today) / (1000 * 60 * 60 * 24));

      return {
        date,
        formatted: expirationDate.toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric'
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
