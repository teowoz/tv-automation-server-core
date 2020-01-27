// Copy and fix yarn script, so it works on windows:
// https://github.com/meteor/meteor/issues/7918
// https://forums.meteor.com/t/cant-use-meteor-yarn-add-bcrypt/42084

const fs = require('fs')

const content = fs.readFileSync('./.meteor/local/dev_bundle/yarn.cmd').toString()
const newContent = content.replace("%dp0%\\node_modules", "%dp0%\..\\node_modules")

fs.writeFile('./.meteor/local/dev_bundle/bin/yarn.cmd', newContent, function (err) {
  if (err) return console.log(err)
});