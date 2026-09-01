module.exports = {
  apps: [
    {
      name: "storage-move",
      script: "./scheduler.js",
      interpreter: "node",
      autorestart: true,
    },
  ],
};
