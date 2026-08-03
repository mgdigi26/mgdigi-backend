const bcrypt = require("bcryptjs");

(async () => {
  const hash = await bcrypt.hash("Admin@123", 10);
  console.log(hash);
})();
