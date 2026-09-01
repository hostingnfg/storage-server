import express from "express";

const app = express();
const PORT = process.env.PORT || 54111;

app.post("/upload-file", (req, res) => {
  res.status(501).json({ message: "Not implemented" });
});

app.get("/download-file", (req, res) => {
  res.status(501).json({ message: "Not implemented" });
});

app.listen(PORT, () => {
  console.log(`Storage server listening on http://localhost:${PORT}`);
});
