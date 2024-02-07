const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(express.json());
const server = http.createServer(app);

const { MongoClient } = require("mongodb");
const url = process.env.DB_URL;

const dbName = "testDB";
const questionsCollection = "questions";
const leaderboardCollection = "leaderboard";
const totalGameTime = 120;

let db;
let adminSocket = null;

MongoClient.connect(url)
  .then((client) => {
    db = client.db(dbName);
    console.log("Successfully established connection with MongoDB");
  })
  .catch((err) => {
    throw err;
  });

app.use(
  cors({
    origin: "*",
    credentials: true,
    methods: ["GET", "PUT", "POST", "DELETE"],
  })
);

const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "PUT", "POST", "DELETE"],
    credentials: true,
  },
});

const userTimers = {};

io.on("connection", (socket) => {
  // console.log("A user connected");

  if (socket.handshake.auth.role === "admin") {
    adminSocket = socket;
    // console.log("Admin connected");

    sendLeaderboardDataToAdmin();
  } else {
    userTimers[socket.id] = {
      value: 120,
      interval: null,
    };

    io.to(socket.id).emit("timer", formatTimer(userTimers[socket.id].value));

    socket.on("disconnect", () => {
      // console.log("User disconnected");
      clearInterval(userTimers[socket.id].interval);
      delete userTimers[socket.id];

      sendLeaderboardDataToAdmin();
    });

    socket.on("startTimer", () => {
      // console.log("Starting timer...");
      clearInterval(userTimers[socket.id].interval);
      startUserTimer(socket.id);
    });
  }
});

function sendLeaderboardDataToAdmin() {
  if (adminSocket) {
    fetchLeaderboardData()
      .then((leaderboardData) => {
        adminSocket.emit("leaderboardUpdate", leaderboardData);
      })
      .catch((error) => {
        console.error("Error fetching leaderboard data:", error);
      });
  }
}

async function fetchLeaderboardData() {
  try {
    const leaderboardData = await fetchLeaderboard();
    return leaderboardData;
  } catch (err) {
    throw err;
  }
}

function startUserTimer(socketId) {
  userTimers[socketId].interval = setInterval(() => {
    if (userTimers[socketId].value > 0) {
      userTimers[socketId].value--;
    }
    const formattedTimer = formatTimer(userTimers[socketId].value);

    // console.log(formattedTimer);
    io.to(socketId).emit("timer", formattedTimer);

    if (userTimers[socketId].value === 0) {
      clearInterval(userTimers[socketId].interval);
      // console.log("Timer stopped");
    }
  }, 1000);
}

function formatTimer(timerValue) {
  const minutes = String(Math.floor(timerValue / 60)).padStart(2, "0");
  const seconds = String(timerValue % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

app.get("/timer", (req, res) => {
  const socketId = req.query.socketId;

  if (userTimers[socketId]) {
    res.json({ timer: formatTimer(userTimers[socketId].value) });
  } else {
    res.status(404).json({ error: "Timer not found for the specified user" });
  }
});

app.post("/game", async (req, res) => {
  try {
    const qId = req.body.qId;
    const userAnswer = req.body.userAnswer;
    const actualAnswer = await checkAnswer(qId);
    if (actualAnswer.toLowerCase() === userAnswer.toLowerCase()) {
      return res.json({ success: true });
    } else {
      return res.json({ success: false });
    }
  } catch (err) {
    res.status(500).json({ Description: err });
  }
});

app.post("/endgame", async (req, res) => {
  const timer = req.body.timer;
  const crates = req.body.crates;
  const teamName = req.body.teamName;

  try {
    let strArr = timer.split(":");
    let numArr = strArr.map((item) => +item);
    let timeLeft = numArr[1] + 60 * numArr[0];
    let timeTaken = totalGameTime - timeLeft;
    const result = await updateScore(teamName, timeTaken, crates);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json(err);
  }
});

app.post("/", async (req, res) => {
  const adminPass = req.body.adminPass;
  const teamName = req.body.teamName;

  try {
    if (adminPass != process.env.ADMIN_PASS) {
      return res.status(401).json({ Description: "Unauthorized" });
    }

    const foundTeamName = await fetchTeamName(teamName);
    if (foundTeamName) {
      return res.status(409).json({ Description: "Team name already exists" });
    }
  } catch (err) {
    return res.status(500).json({ Description: err });
  }

  return res.status(200).json({ Description: "Authorized" });
});

app.get("/questions", async (req, res) => {
  try {
    const questions = await fetchQuestions();
    res.status(200).json(questions);
  } catch (err) {
    res.status(500).json(err);
  }
});

app.get("/leaderboard", async (req, res) => {
  try {
    const result = await fetchLeaderboard();
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json(err);
  }
});

async function fetchLeaderboard() {
  try {
    return db
      .collection(leaderboardCollection)
      .aggregate([
        {
          $sort: { crates: -1, timeTaken: 1 },
        },
      ])
      .toArray();
  } catch (err) {
    return err;
  }
}

async function updateScore(teamName, timeTaken, crates) {
  try {
   const result = await db.collection(leaderboardCollection).updateOne(
      {
        teamName: teamName,
      },
      {
        $set: {
          timeTaken: timeTaken,
          crates: crates,
        },
      }
    );
    sendLeaderboardDataToAdmin();
  } catch (err) {
    return err;
  }
}

async function checkAnswer(qId) {
  try {
    const question = await db.collection(questionsCollection).findOne({
      id: qId,
    });
    return question.answer;
  } catch (err) {
    return err;
  }
}

async function fetchTeamName(teamName) {
  teamName = teamName;
  try {
    const foundTeamName = await db.collection(leaderboardCollection).findOne({
      teamName: teamName,
    });
    if (foundTeamName) {
      return foundTeamName;
    }
    await db.collection(leaderboardCollection).insertOne({
      teamName: teamName,
      timeTaken: 0,
      crates: 0,
    });
  } catch (error) {
    throw new Error("Error creating team");
  }
}

async function fetchQuestions() {
  try {
    const questions = await db
      .collection(questionsCollection)
      .find({}, { projection: { _id: 0, id: 1, question: 1 } })
      .toArray();
    return questions;
  } catch (err) {
    return err;
  }
}

const PORT = 5000;
server.listen(PORT, () => {
  console.log(`Socket.IO server is running on port ${PORT}`);
});
