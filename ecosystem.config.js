module.exports = {
  apps: [
    {
      name: "barber-bot",
      script: "index.js",
      watch: true
    },
    {
      name: "ngrok-tunnel",
      script: "C:\\Users\\Pichau\\Desktop\\base_teste\\barber-bot\\node_modules\\ngrok\\bin\\ngrok.exe", // <--- COLE O CAMINHO AQUI
      args: "http 3000 --domain=twilight-undocked-chaffing.ngrok-free.dev",
      interpreter: "none",
      watch: false
    }
  ]
};