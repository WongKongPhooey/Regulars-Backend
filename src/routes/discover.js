const { Router } = require("express");
const discoverController = require("../controllers/discoverController");

const router = Router();

router.get("/", discoverController.getDiscover);

module.exports = router;
