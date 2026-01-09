const API_KEY = '4XSRhlvXpqDZi_pNgZfvnscjv69WhgGt';

const res = await fetch(
    `https://api.polygon.io/v3/snapshot/options/AAPL?apiKey=${API_KEY}`
);

const data = await res.json();
console.log('0:', data.results[0]);
console.log('1:', data.results[1]);
