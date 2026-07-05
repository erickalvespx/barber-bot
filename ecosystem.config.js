module.exports = {
  apps: [
    {
      name: "barber-bot",
      script: "index.js",
      watch: true
    },
    {
      name: "ngrok-tunnel",
      script: "ngrok", // <--- COLE O CAMINHO AQUI
      args: "http 3000 --domain=twilight-undocked-chaffing.ngrok-free.dev",
      interpreter: "none",
      watch: false
    }
  ]
};