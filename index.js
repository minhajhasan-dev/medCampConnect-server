const express = require("express");
const app = express();
require("dotenv").config();
const cors = require("cors");
const axios = require("axios"); // added last
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 8000;

// middleware
const corsOptions = {
  origin: ["http://localhost:5173", "http://localhost:5174"],
  credentials: true,
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(cookieParser());

// Verify Token Middleware
const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token;
  console.log(token);
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      console.log(err);
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.user = decoded;
    next();
  });
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.uqfy7cb.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("MedCampConnect");
    const campsCollection = db.collection("Camps");
    const usersCollection = db.collection("users");
    const bookingCollection = db.collection("bookings");
    const feedbackCollection = db.collection("feedbacks");
    const sliderCollection = db.collection("SliderData");

    // verify Organizer middleware
    const verifyOrganizer = async (req, res, next) => {
      console.log("hello");
      const user = req.user;
      const query = { email: user?.email };
      const result = await usersCollection.findOne(query);
      console.log(result?.role);
      if (!result || result?.role !== "organizer") {
        return res.status(401).send({ message: "unauthorized access!!" });
      }
      next();
    };
    // verify Participant middleware
    const verifyParticipant = async (req, res, next) => {
      console.log("hello");
      const user = req.user;
      const query = { email: user?.email };
      const result = await usersCollection.findOne(query);
      console.log(result?.role);
      if (!result || result?.role !== "participant") {
        return res.status(401).send({ message: "unauthorized access!!" });
      }
      next();
    };

    // auth related api
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "365d",
      });
      res
        .cookie("token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
        })
        .send({ success: true });
    });
    // Logout
    app.get("/logout", async (req, res) => {
      try {
        res
          .clearCookie("token", {
            maxAge: 0,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
          })
          .send({ success: true });
        console.log("Logout successful");
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // create-payment-intent
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      const price = req.body.price;
      const priceInCents = parseFloat(price) * 100;
      if (!price || priceInCents < 1)
        return res.status(400).send({ message: "Invalid price" });
      //generate clientSecret
      const { client_secret } = await stripe.paymentIntents.create({
        amount: priceInCents,
        currency: "usd",
        automatic_payment_methods: {
          enabled: true,
        },
      });
      // send client secret as response
      res.send({ clientSecret: client_secret });
    });

    // get all payment information
    app.get("/payments", verifyToken, async (req, res) => {
      const payments = await stripe.paymentIntents.list();
      res.send(payments);
    });

    // save a user data in db with email, name, role, photo and timestamp
    app.put("/user", async (req, res) => {
      const user = req.body;
      console.log(req.body);
      // chack if user already exist in db
      const isExist = await usersCollection.findOne({ email: user.email });
      if (isExist) {
        return res.send(isExist);
      }
      // save user for the first time
      const options = { upsert: true };
      const query = { email: user.email };
      const updateDoc = {
        $set: {
          ...user,
          timestamp: Date.now(),
        },
      };
      const result = await usersCollection.updateOne(query, updateDoc, options);
      res.send(result);
    });

    // get a user info by email from db
    app.get("/user/:email", async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send(result);
    });

    // get all users data from db
    app.get("/users", verifyToken, verifyOrganizer, async (req, res) => {
      const result = await usersCollection.find({}).toArray();
      res.send(result);
    });

    // get all camps data from db
    app.get("/camps", async (req, res) => {
      // implement sort, search
      const sort = req.query.sort;
      const search = req.query.search || "";
      const query = {
        $or: [
          { camp_name: { $regex: search, $options: "i" } },
          { date: { $regex: search, $options: "i" } },
          { location: { $regex: search, $options: "i" } },
        ],
      };
      let options = {};

      // implement sort functionality based on most-registered, camp fees, camp name matching from database data
      if (sort === "most-registered") {
        options = { sort: { participant_count: -1 } };
      } else if (sort === "camp-fees") {
        options = { sort: { camp_fees: 1 } };
      } else if (sort === "camp-name") {
        options = { sort: { camp_name: 1 } };
      }

      const result = await campsCollection.find(query, options).toArray();
      res.send(result);
    });

    // get sorted camps by participant count from db
    app.get("/sortedCamps", async (req, res) => {
      // sort by participant count from highest to lowest
      const camps = await campsCollection
        .find({})
        .sort({ participant_count: -1 })
        .limit(6)
        .toArray();
      res.send(camps);
    });

    // get a single room data from db from id
    app.get("/camp/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await campsCollection.findOne(query);
      res.send(result);
    });

    // save booking data in db
    app.post("/bookings", verifyToken, async (req, res) => {
      const bookingData = req.body;
      // save camp booking info
      const result = await bookingCollection.insertOne(bookingData);
      res.send(result);
    });

    // post a camp data in db
    app.post("/camps", verifyToken, verifyOrganizer, async (req, res) => {
      const campData = req.body;
      const result = await campsCollection.insertOne(campData);
      res.send(result);
    });
    // delete a camp data from db
    app.delete("/camp/:id", verifyToken, verifyOrganizer, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await campsCollection.deleteOne(query);
      res.send(result);
    });
    // update a camp data in db
    app.put(
      "/update-camp/:campId",
      verifyToken,
      verifyOrganizer,
      async (req, res) => {
        const campId = req.params.campId;
        const updatedCamp = req.body;
        const query = { _id: new ObjectId(campId) };
        const updateDoc = {
          $set: {
            ...updatedCamp,
          },
        };
        const result = await campsCollection.updateOne(query, updateDoc);
        res.send(result);
      }
    );

    // get all booking data for organizer
    app.get("/bookings", verifyToken, verifyOrganizer, async (req, res) => {
      const result = await bookingCollection.find({}).toArray();
      res.send(result);
    });

    // get all booking data for participant
    app.get(
      "/bookings/:email",
      verifyToken,
      // verifyParticipant,
      async (req, res) => {
        const email = req.params.email;
        const query = { participant_email: email };
        const result = await bookingCollection.find(query).toArray();
        res.send(result);
      }
    );
    // update the participants count by 1 in camp collection by patch
    app.patch("/camp/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $inc: {
          participant_count: 1,
        },
      };
      const result = await campsCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // participant statistics api
    app.get(
      "/participant-stats/:email",
      verifyToken,
      verifyParticipant,
      async (req, res) => {
        // get total fees paid by the participant and total camps joined by the participant
        const email = req.user.email;
        const query = { participant_email: email };
        const result = await bookingCollection.find(query).toArray();
        const totalFees = result.reduce(
          (acc, curr) => acc + parseFloat(curr.camp_fees),
          0
        );
        const totalCamps = result.length;

        // chart data by react google chart api
        const chartData = result.map((camp) => {
          return [camp.camp_name, parseFloat(camp.camp_fees)];
        });
        chartData.unshift(["Camp", "Fees"]);
        res.send({ totalFees, totalCamps, chartData });
      }
    );

    // save feedback data in db
    app.post("/feedbacks", async (req, res) => {
      const feedbackData = req.body;
      const result = await feedbackCollection.insertOne(feedbackData);
      res.send(result);
    });

    // get all feedbacks from db
    app.get("/feedbacks", async (req, res) => {
      const result = await feedbackCollection.find({}).toArray();
      res.send(result);
    });

    // get all feedback data from db using campId
    app.get("/feedback/:campId", async (req, res) => {
      const campId = req.params.campId;
      const query = { campId };
      const result = await feedbackCollection.find(query).toArray();
      res.send(result);
    });

    //get a single bookingInfo with the email addres and campId to show in the bookingRow
    app.get("/booking/:email/:campId", async (req, res) => {
      const email = req.params.email;
      const campId = req.params.campId;
      const query = { participant_email: email, campId };
      const result = await bookingCollection.findOne(query);
      res.send(result);
    });

    // delete a single bnookingInfo with email address and campId from db
    app.delete("/booking/:email/:campId", async (req, res) => {
      const email = req.params.email;
      const campId = req.params.campId;
      const query = { participant_email: email, campId };
      const result = await bookingCollection.deleteOne(query);
      res.send(result);
    });

    // imgbb related
    app.post("/upload", async (req, res) => {
      try {
        const response = await axios.post(
          "https://api.imgbb.com/1/upload",
          req.body
        );
        res.send(response.data);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Error uploading image" });
      }
    });

    // load SliderData from db
    app.get("/slider", async (req, res) => {
      const result = await sliderCollection.find({}).toArray();
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from MedCampConnect Server..");
});

app.listen(port, () => {
  console.log(`MedCampConnect is running on port ${port}`);
});
