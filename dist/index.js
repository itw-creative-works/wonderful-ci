const Manager = (new (require('backend-manager'))).init(
  exports,
  {
    log: true,
    serviceAccountPath: 'wonderful-ci/service-account.json',
    backendManagerConfigPath: 'wonderful-ci/backend-manager-config.json',
    useFirebaseLogger: false,
    fetchStats: false,
    checkNodeVersion: false,
    // uniqueAppName: appId,
  }
)
const path = require('path');
const { get, set } = Manager.require('lodash');
const fetch = Manager.require('wonderful-fetch');
const jetpack = Manager.require('fs-jetpack');
const powertools = Manager.require('node-powertools');
const argv = Manager.require('yargs').argv

const { exec } = require('child_process');
const chalk = require('chalk');
const { Octokit } = require('@octokit/rest');
const crypto = require('crypto');
const yaml = require('yaml');
const mime = require('mime-types');
const packageJSON = require('../package.json');
let nutjs;

// const activeWindow = function () {
//   return new Promise(function(resolve, reject) {
//     try {
//       require('active-window').getActiveWindow(function (win) {
//         if (win) {
//           return resolve(win)
//         } else {
//           return reject(new Error('No window'))
//         }   
//       });      
//     } catch (e) {
//       return reject(e)
//     }
//   });
// }

const blacklist = [];
const isDevelopment = Manager.assistant.meta.environment === 'development';
// const isDevelopment = false;
const signedNew = isDevelopment ? '-SIGNED' : '';
const SIGNED = '-SIGNED';

function Main() {
  const self = this;
  
  self.options = {};
  self.listener = null;
}

Main.prototype.main = async function (options) {
  const self = this;
  self.options = options || {};

  self.octokit = new Octokit({
    auth: process.env.GH_TOKEN,
  })

  // Create directories
  jetpack.dir('wonderful-ci')  

  await self.octokit.request('GET /zen', {})    
  .then(zen => {

    setInterval(function () {
      self.attachListener();
    }, 1000 * 60 * 10);
    self.attachListener();
    
    console.log(chalk.green(`Ready to listen for updates (wonderful-ci v${packageJSON.version}): ${zen.data}`));

  })
  .catch(e => {
    console.error(chalk.red(`Error authenticating GitHub: ${e.message} \n${e.stack}`));
    return process.exit(1)
  })    

};

Main.prototype.attachListener = function () {
  const self = this;

  if (self.listener) {
    self.listener();
  }

  self.listener = Manager.libraries.admin.firestore()
    .collection('ci-builds')
    .where('date.timestampUNIX', '>=', (new Date().getTime() / 1000))
    .onSnapshot((snap) => {
      snap.forEach(doc => {
        const id = doc.ref.path;
        const data = doc.data();
        
        if (
          blacklist.find(item => id === item.id && data.date.timestampUNIX === item.timestampUNIX)
        ) {
          console.warn(chalk.yellow(`Skipping ${id} update because it's currently processing or already processed`));
        } else {
          self.process(id, data)
          .then(r => {
            self.statusUpdate(id, 'complete').catch(e => e)
            console.log(chalk.green(`\n*-*-*- Completed ${data.package.productName} v${data.package.version} - ${id} -*-*-*`));
          })          
          .catch(e => {
            self.statusUpdate(id, e).catch(e => e)
            console.error(chalk.red(`Error processing update: ${e.message} \n${e.stack}`));
          })            
        }

      })
    }, (e) => {
      console.error(chalk.red(`Error fetching update: ${e.message} \n${e.stack}`));
      process.exit(1)
    })

    console.error(chalk.blue(`Attaching new Firestore listener: ${new Date().toLocaleString()}`));

};

Main.prototype.process = function (id, data) {
  const self = this;

  return new Promise(async function(resolve, reject) {

    const options = {
      download: argv.download !== 'false',
      sign: argv.sign !== 'false',
      uploadToUpdateServer: argv.uploadToUpdateServer !== 'false',
      uploadToDownloadServer: argv.uploadToDownloadServer !== 'false',
      publishUpdateServer: argv.publishUpdateServer !== 'false',
      clean: argv.clean !== 'false',
      
      wait: argv.wait !== 'false',
    }

    blacklist.push({id: id, timestampUNIX: data.date.timestampUNIX})
    
    const statusReset = await self.statusUpdate(id, null).catch(e => e);

    if (statusReset instanceof Error) {
      return reject(statusReset)
    }

    if (false
      || !get(data, 'package.update.owner')
      || !get(data, 'package.update.repo')
      || !get(data, 'package.download.owner')
      || !get(data, 'package.download.repo')
      || !get(data, 'package.download.tag')
      || !get(data, 'package.version')
    ) {
      return reject(new Error('Missing required payload data'))
    }

    console.log(chalk.green(`\n*-*-*- Publishing ${data.package.productName} v${data.package.version} - ${id} -*-*-*`));
    
    if (options.wait) {
      await powertools.wait(2000)
    }

    // console.log(chalk.blue(`New payload: ${id} ${data.package.update.owner} @ ${data.package.version}`));

    const updateServerReleases = await self.listReleases(data.package.update).catch(e => []);
    const currentUpdateServerRelease = self.getCurrentRelease(updateServerReleases, data.package.version);

    if (!currentUpdateServerRelease || !currentUpdateServerRelease.assets || currentUpdateServerRelease.assets.length === 0) {
     return reject(new Error(`There is no current release for this version: ${data.package.version}`))
    }

    console.log(chalk.blue(`Current release: ${chalk.bold(currentUpdateServerRelease.assets.length)} assets`));

    // Create directory
    jetpack.dir(path.join('assets', data.package.name))

    // Download
    if (options.download) {
      const result = await self.process_download(currentUpdateServerRelease, data).catch(e => e);
      if (result instanceof Error) {
        return reject(result);
      }
    } else {
      console.warn(chalk.yellow(`\nSkipping download`));
    }
    
    // Sign
    if (options.sign) {
      const result = await self.process_sign(currentUpdateServerRelease, data).catch(e => e);
      if (result instanceof Error) {
        return reject(result);
      }
    } else {
      console.warn(chalk.yellow(`\nSkipping signing`));
    }   

    // Upload updates
    if (options.uploadToUpdateServer) {
      const result = await self.process_uploadToUpdateServer(currentUpdateServerRelease, data).catch(e => e);
      if (result instanceof Error) {
        return reject(result);
      }
    } else {
      console.warn(chalk.yellow(`\nSkipping uploading update-server files`));
    }

    // Upload installer
    if (options.uploadToDownloadServer) {
      const result = await self.process_uploadToDownloadServer(data).catch(e => e);
      if (result instanceof Error) {
        return reject(result);
      }      
    } else {
      console.warn(chalk.yellow(`\nSkipping uploading download-server files`));
    }

    // Release update server
    if (options.publishUpdateServer) {
      const result = await self.process_publishUpdateServer(currentUpdateServerRelease, data).catch(e => e);
      if (result instanceof Error) {
        return reject(result);
      }      
    } else {
      console.warn(chalk.yellow(`\nSkipping publishing update-server files`));
    }

    // Clean asset folder
    jetpack.remove(path.join('assets', data.package.name))

    return resolve();
  });
};


/*
 * PROCESSSES
*/
Main.prototype.process_download = function (currentRelease, data) {
  const self = this;

  return new Promise(function(resolve, reject) {
    let downloadPromises = [];
    
    console.log(chalk.blue(`\nDownloading files...`));

    // Clean asset folder
    jetpack.remove(path.join('assets', data.package.name))

    self.iterateRelevantAssets(currentRelease, data, (asset) => {
      downloadPromises.push(self.download(data.package.name, asset, data.package.update))
    })

    Promise.all(downloadPromises)
    .then(e => {
      console.log(chalk.green(`Download complete: ${downloadPromises.length} files`));

      resolve()
    })
    .catch(e => reject(e));

  });
};

Main.prototype.process_sign = function (currentRelease, data) {
  const self = this;

  return new Promise(async function(resolve, reject) {
    console.log(chalk.blue(`\nSigning files...`));

    let signPromise;

    Manager.config.signing = Manager.config.signing || {};
    Manager.config.signing.command = Manager.config.signing.command 
      || `${Manager.config.signing.signToolPath ? `"${Manager.config.signing.signToolPath}"` : 'signtool'} sign /f {certificatePath} /p {certificatePassword} /t {timestampServer} /n "{productPublisher}" /fd SHA256 {inputFileName}`;

    // Checks
    if (!Manager.config.signing.certificatePath) {
      return reject(new Error('Missing <certificatePath>'))
    } else if (!process.env.CERTIFICATE_PASSWORD) {
      return reject(new Error('Missing <CERTIFICATE_PASSWORD>'))
    } else if (!Manager.config.signing.timestampServer) {
      return reject(new Error('Missing <timestampServer>'))
    }
    // } else if (!Manager.config.signing.productPublisher) {
    //   return reject(new Error('Missing <productPublisher>'))
    // }

    // Perform sign
    for (var i = 0; i < 3; i++) {
      signPromise = await self.process_signInner(currentRelease, data, i).catch(e => e);
      if (!(signPromise instanceof Error)) {
        return resolve()
      }
    }

    return reject(new Error('Failed to sign after multiple attempts'));
  });
};

Main.prototype.process_signInner = function (currentRelease, data, attempt) {
  return new Promise(async function(resolve, reject) {
    let signPromise;
    let passwordPromise;

    const exePath = path.join('assets', data.package.name, `${getHyphenatedName(data)}-Setup-${data.package.version}.exe`);
    const exePathSigned = path.join('assets', data.package.name, `${getHyphenatedName(data)}-Setup-${data.package.version}${SIGNED}.exe`);

    // Command builder
    const command = Manager.config.signing.command
      .replace(/{certificatePath}/ig, path.join(process.cwd(), Manager.config.signing.certificatePath))
      .replace(/{certificatePassword}/ig, process.env.CERTIFICATE_PASSWORD)
      .replace(/{timestampServer}/ig, Manager.config.signing.timestampServer)
      .replace(/{productPublisher}/ig, Manager.config.signing.productPublisher)
      .replace(/{inputFileName}/ig, path.join(process.cwd(), exePathSigned))

    // Clean signed EXE
    jetpack.remove(exePathSigned)
    jetpack.copy(exePath, exePathSigned)

    console.log(chalk.blue(`Command (${attempt}): ${command}`));

    if (getPlatform() === 'windows') {
      signPromise = asyncCommand(command).catch(e => passwordPromise = e)
    }

    // Automate password typing
    await powertools.poll(async () => {
      const win = await asyncCommand('tasklist /fi "windowtitle eq Token Logon*"').catch(e => {
        console.log(chalk.red(`Failed to get windows: ${e.message} \n${e.stack}`));
      });

      if (getPlatform() !== 'windows') {
        return true
      } else if (win && win.includes('signtool.exe')) {
        return true
      }
    }, {interval: 7000, timeout: 60000})
    .then(async (r) => {
      console.log(chalk.blue(`Typing password to signtool.exe`));
      nutjs = nutjs || require(path.join(process.cwd(), 'node_modules', '@nut-tree/nut-js'));
      nutjs.keyboard.config.autoDelayMs = 100;
      await nutjs.keyboard.type(process.env.CERTIFICATE_PASSWORD).catch(e => passwordPromise = e)
      await nutjs.keyboard.type(nutjs.Key.Enter).catch(e => passwordPromise = e)
    })
    .catch(e => passwordPromise = e)

    await signPromise

    if (passwordPromise instanceof Error) {
      return reject(passwordPromise);
    } else if (signPromise instanceof Error) {
      return reject(signPromise);
    }

    console.log(chalk.green(`Sign completed successfully`));
    return resolve()    
  });
};

Main.prototype.process_uploadToUpdateServer = function (currentRelease, data) {
  const self = this;

  return new Promise(async function(resolve, reject) {
    console.log(chalk.blue(`\nUploading update-server files...`));   

    let processPromises = [];

    // const exeName = 
    const exePathSigned = path.join('assets', data.package.name, `${getHyphenatedName(data)}-Setup-${data.package.version}${SIGNED}.exe`);
    const yamlPath = path.join('assets', data.package.name, `latest.yml`);
    const yamlPathSigned = path.join('assets', data.package.name, `latest${SIGNED}.yml`);

    // Update YAML
    const stats = jetpack.inspect(exePathSigned);
    let yamlFile = yaml.parse(jetpack.read(yamlPath));
    let yamlFileConverted;
    const hash = await self.fileHash(exePathSigned).catch(e => e);

    if (hash instanceof Error) {
      return reject(hash);
    }

    yamlFile.files[0].sha512 = hash;
    yamlFile.files[0].size = stats.size;
    yamlFile.sha512 = hash;
    
    // Replace the releaseDate because YAML removes quotes
    yamlFileConverted = yaml.stringify(yamlFile)
      .replace(yamlFile.releaseDate, `'${yamlFile.releaseDate}'`)

    jetpack.write(yamlPathSigned, yamlFileConverted);   

    // Upload release
    self.iterateRelevantAssets(currentRelease, data, (asset) => {
      let filePath;
      let fileName;
      
      if (asset.name.match(/\.yml/)) {
        filePath = yamlPathSigned
      } else if (asset.name.match(/\.exe/)) {
        filePath = exePathSigned
      }

      // fileName = asset.name.replace('.', `${signedNew}.`)
      fileName = asset.name;

      // console.log('---fileName', fileName);

      if (filePath) {
        processPromises.push(
          self.updateReleaseAsset(data.package.update, currentRelease, asset, filePath, fileName)
        )
      }

    })

    Promise.all(processPromises)
    .then(e => {
      console.log(chalk.green(`Upload update-server complete: ${processPromises.length} files`));

      resolve()
    })
    .catch(e => reject(e));

  });
};

Main.prototype.process_uploadToDownloadServer = function (data) {
  const self = this;

  return new Promise(async function(resolve, reject) {
    console.log(chalk.blue(`\nUploading download-server files...`));   

    let processPromises = [];
    let release;
    
    // @universal
    const assetsToUpload = [
      {
        path: path.join('assets', data.package.name, `${getHyphenatedName(data)}-Setup-${data.package.version}${SIGNED}.exe`),
        name: `${getHyphenatedName(data)}-Setup.exe`,
        match: /\.exe/ig,
      },
      {
        // path: path.join('assets', data.package.name, `${getHyphenatedName(data)}-${data.package.version}.dmg`),
        path: path.join('assets', data.package.name, `${getHyphenatedName(data)}-${data.package.version}-universal.dmg`),
        name: `${getHyphenatedName(data)}.dmg`,
        match: /\.dmg/ig,
      },
      {
        path: path.join('assets', data.package.name, `${getHyphenatedName(data).toLowerCase()}_${data.package.version}_amd64.deb`),
        name: `${getHyphenatedName(data).toLowerCase()}_amd64.deb`,
        match: /_amd64\.deb/ig,
      },      
      {
        path: path.join('assets', data.package.name, `${getHyphenatedName(data).toLowerCase()}_${data.package.version}_i386.deb`),
        name: `${getHyphenatedName(data).toLowerCase()}_i386.deb`,
        match: /_i386\.deb/ig,
      },           
    ]

    async function _getRelease() {
      const downloadServerReleases = await self.listReleases(data.package.download).catch(e => []);

      if (!downloadServerReleases || downloadServerReleases.length === 0) {
        throw new Error(`There is no installer`)
      }

      // return downloadServerReleases[0];
      return downloadServerReleases.find(r => r.tag_name === 'installer' || r.name === 'installer');
    }

    console.log(chalk.blue(`Checking for installer tag...`));  

    release = await _getRelease().catch(e => e)

    if (release instanceof Error) {
      console.log(chalk.blue(`Creating installer tag...`));  

      await self.octokit.rest.repos.createRelease({
        owner: data.package.download.owner,
        repo: data.package.download.repo,
        tag_name: 'installer',
        draft: false,
      })
      .then(async (r) => {

        await powertools.poll(async (index) => {
          release = await _getRelease().catch(e => e)
          if (release instanceof Error) {
            console.log(chalk.yellow(`Could not find new installer tag. Searching again ${index}...`));  
          } else {
            console.log(chalk.green('Created installer tag'));
            return true;
          }  
        }, {interval: 3000, timeout: 35000})
        .catch(e => {
          console.error(chalk.red(new Error(`Failed to create installer tag: ${release.message} \n${release.stack}`)));   
        })

      })
      .catch(e => release = e)

      if (release instanceof Error) {
        return reject(release);
      }   
    }

    console.log(chalk.blue(`Installer tag is ready`));  

    // Upload release
    assetsToUpload
    .forEach(asset => {
      const currentReleaseAssets = get(release, 'assets', [])
      const liveAsset = currentReleaseAssets.find(a => a.name.match(asset.name));

      processPromises.push(
        self.updateReleaseAsset(data.package.download, release, liveAsset, asset.path, asset.name)
      )
    })

    Promise.all(processPromises)
    .then(e => {
      console.log(chalk.green(`Upload download-server complete: ${processPromises.length} files`));

      resolve()
    })
    .catch(e => reject(e));

  });
};


Main.prototype.process_publishUpdateServer = function (currentRelease, data) {
  const self = this;

  return new Promise(async function(resolve, reject) {
    console.log(chalk.blue(`\nPublishing ${data.package.version} update-server files...`));   

    self.octokit.repos.updateRelease({
      owner: data.package.update.owner,
      repo: data.package.update.repo,
      release_id: currentRelease.id,
      draft: false,
      tag_name: `v${data.package.version}`
    })
    .then(r => {
      console.log(chalk.green(`v${data.package.version} has been published!`));
      return resolve()
    })
    .catch(e => reject(e))

  });
};


/*
* HELPERS
*/
Main.prototype.listReleases = function (payload) {
  const self = this;

  return new Promise(function(resolve, reject) {
    self.octokit.repos.listReleases({
      owner: payload.owner,
      repo: payload.repo,
      per_page: 100,
    })
    .then(releases => {
      if (!releases || !releases.data || releases.data.length < 1) {
        return resolve([])
      }
      return resolve(releases.data)
    })
    .catch(e => reject(e))     
  });
};

Main.prototype.getCurrentRelease = function (releases, match) {
  const self = this;

  const currentRelease = releases.find(rel => rel.name === match);
  if (!currentRelease) {
    return null;
  }    
  return currentRelease;
};

Main.prototype.updateReleaseAsset = function (payload, release, asset, filePath, name) {
  const self = this;

  // console.log('---', payload, release, filePath, name);
  // console.log('updateReleaseAsset', `\nexisting=${asset.name}`, `\nname=${name}`, `\npath=${filePath}`);

  return new Promise(async function(resolve, reject) {

    if (asset) {
      // Asset exists live, delete it
      console.log(chalk.blue(`Deleting live asset: ${asset.name}`));

      const deleteResult = await self.octokit.repos.deleteReleaseAsset({
        owner: payload.owner,
        repo: payload.repo,
        asset_id: asset.id,
      })
      .catch(e => e);  

      if (deleteResult instanceof Error) {
        if (deleteResult.status !== 404) {
          return reject(deleteResult)
        }
      }  
      console.log(chalk.green(`Deleted live asset: ${asset.name}`));
    } else {
      console.log(chalk.blue(`Skipping non-existant live asset: ${name}`));
    }

    console.log(chalk.blue(`Uploading asset: ${name}`));
    
    self.octokit.repos.uploadReleaseAsset({
      owner: payload.owner,
      repo: payload.repo,
      release_id: release.id,
      data: jetpack.createReadStream(filePath),
      headers: {
        'content-type': mime.lookup(filePath),
        'content-length': jetpack.inspect(filePath).size,
      },
      name: name,
    })
    .then(r => {
      console.log(chalk.green(`Uploaded asset: ${name}`));
      return resolve();
    })
    .catch(e => reject(e)); 
  });  
};

Main.prototype.download = function (name, release, update) {
  const self = this;
  
  return new Promise(async function(resolve, reject) { 
    const downloadURL = release.browser_download_url;
    const savePath = path.join(process.cwd(), 'assets', name, release.name);    

    console.log(chalk.blue(`Downloading: ${release.name} (${release.id}) to ${savePath}`));

    await self.octokit.request('GET /repos/{owner}/{repo}/releases/assets/{asset_id}', {
      owner: update.owner,
      repo: update.repo,
      asset_id: release.id,
      headers: {
        Accept: 'application/octet-stream'
      },
    })
    .then(r => {
      jetpack.write(savePath, Buffer.from(r.data));
      console.log(chalk.green(`Downloaded: ${release.name} (${release.id}) to ${savePath}`));
      return resolve()
    })
    .catch(e => reject(e))

  });
};

Main.prototype.fileHash = function (filename, algorithm = 'sha512', encoding = 'base64') {
  return new Promise((resolve, reject) => {
    // Algorithm depends on availability of OpenSSL on platform
    // Other algorithms: 'sha1', 'md5', 'sha256', 'sha512' ...
    const shasum = crypto.createHash(algorithm);
    // console.log(chalk.blue(`\nHashing... ${algorithm} ${encoding}`));

    try {
      const s = jetpack.createReadStream(filename)
      s.on('data', function (data) {
        shasum.update(data)
      })
      // making digest
      s.on('end', function () {
        const hash = shasum.digest(encoding);
        return resolve(hash);
      })

    } catch (error) {
      return reject(error);
    }
  });
}

Main.prototype.statusUpdate = function (id, status) {
  const self = this;

  const update = {
    complete: false,
    error: null,
  }

  if (status instanceof Error) {
    update.error = `${status.message} \n${status.stack}`;
  } else if (status === 'complete') {
    update.complete = true;
  }

  return new Promise(function(resolve, reject) {
    Manager.libraries.admin.firestore()
      .doc(id)
      .set({
        status: {
          [getPlatform()]: update,        
        }
      },{merge: true})
      .then(r => resolve(r))  
      .catch(r => reject(e))      
  });
};

// || asset.name === `${getHyphenatedName(data)}-Setup-${data.package.version}.exe`
// || asset.name === `latest.yml`
// || asset.name.endsWith('amd64.deb')
Main.prototype.iterateRelevantAssets = function (currentRelease, data, fn) {
  const self = this;
  const platform = getPlatform();

  const matches = []

  for (var i = 0; i < currentRelease.assets.length; i++) {
    const asset = currentRelease.assets[i];
    
    // if (platform === 'windows') {
      if (false
        || asset.name.match(/\.exe$/)
        || asset.name.match(/^latest\.yml$/)
        || asset.name.match(/\.deb$/)
        || asset.name.match(/\.dmg$/)
      ) {
        matches.push(asset)
        if (fn) {
          fn(asset)
        }
      }      
    // }
  }   

  return matches;
};

function getPlatform() {
  if (argv.platform) {
    return argv.platform
  }

  if (process.platform === 'win32') {
    return 'windows'
  } else if (process.platform === 'darwin') {
    return 'mac'
  } else {
    return 'linux'
  }
}

function getHyphenatedName(data) {
  return data.package.productName.replace(/ /ig, '-');  
}

async function asyncCommand(command) {
  return new Promise(function(resolve, reject) {
    exec(command, function (error, stdout, stderr) {
      if (error) {
        return reject(error);
      } else {
        return resolve(stdout);
      }
    });
  });
}

// Transform all console.log, console.error, etc so that it puts the timestamp in front like [2020-01-01 @ 00:00:00]
// Create a custom logger function
const customLogger = (originalFn) => {
  return (...args) => {
    const now = new Date();
    const timestamp = `[${now.toLocaleDateString()} @ ${now.toLocaleTimeString()}]:`;
    originalFn.call(console, timestamp, ...args);
  };
};

// Replace native console functions with custom logger
console.log = customLogger(console.log);
console.error = customLogger(console.error);
console.warn = customLogger(console.warn);
console.info = customLogger(console.info);
console.debug = customLogger(console.debug);

module.exports = Main;
