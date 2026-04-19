const { Router } = require("express");
const notificationController = require("../controllers/notificationController");

const router = Router();

router.post("/register",   notificationController.register);
router.post("/unregister",  notificationController.unregister);

module.exports = router;
