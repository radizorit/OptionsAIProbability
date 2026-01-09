# Options Probability Application

A full-stack React + Node.js application for displaying and analyzing options chain data using the Polygon.io API.

## Features

- View options chain data with strike prices, breakeven points, and Greeks
- Filter by ticker, expiration date, and contract type (Call/Put)
- Real-time pricing with bid/ask support (bid when market is open, close as fallback)
- Dark-themed UI matching professional trading interfaces
- Visual share price indicator on the options chain

## Setup

### Backend Setup

1. Navigate to the backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file (or copy from `.env.example`):
```bash
POLYGON_API_KEY=your_api_key_here
PORT=3001
```

4. Start the backend server:
```bash
npm run dev
```

The backend will run on `http://localhost:3001`

### Frontend Setup

1. Navigate to the frontend directory:
```bash
cd frontend
```

2. Install dependencies:
```bash
npm install
```

3. Start the development server:
```bash
npm run dev
```

The frontend will run on `http://localhost:3000`

## Usage

1. Enter a ticker symbol (e.g., AAPL)
2. Select an expiration date from the dropdown
3. Choose Call or Put options
4. The options chain will display automatically

## API Endpoints

### GET `/api/options`
Fetches options chain data for a given ticker, expiration date, and contract type.

**Query Parameters:**
- `ticker`: Stock ticker symbol (e.g., AAPL)
- `expirationDate`: Expiration date in YYYY-MM-DD format
- `contractType`: Either "call" or "put"

**Response:**
```json
{
  "options": [...],
  "underlyingPrice": 259.33,
  "marketOpen": false
}
```

### GET `/api/expiration-dates`
Fetches available expiration dates for a ticker.

**Query Parameters:**
- `ticker`: Stock ticker symbol

**Response:**
```json
{
  "expirationDates": [
    {
      "date": "2026-01-09",
      "formatted": "January 9, 2026",
      "daysUntil": 1
    }
  ]
}
```

## Project Structure

```
OptionsAIProbability/
├── backend/
│   ├── server.js          # Express API server
│   ├── package.json
│   └── .env               # Environment variables
├── frontend/
│   ├── src/
│   │   ├── App.jsx        # Main React component
│   │   ├── App.css        # Styles
│   │   ├── main.jsx       # React entry point
│   │   └── index.css      # Global styles
│   ├── index.html
│   ├── vite.config.js     # Vite configuration
│   └── package.json
└── README.md
```

## Technologies Used

- **Backend**: Node.js, Express
- **Frontend**: React, Vite
- **API**: Polygon.io Options API
- **Styling**: CSS (dark theme)
