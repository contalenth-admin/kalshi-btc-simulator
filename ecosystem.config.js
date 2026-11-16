module.exports = {
  apps: [
    {
      name: 'kalshi-btc-sim',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '250M',
      env: {
        PORT: 3001,
        NODE_ENV: 'production'
      }
    }
  ]
};
