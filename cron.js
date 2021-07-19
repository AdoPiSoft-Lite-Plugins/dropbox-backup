'use strict';

var {machine_id, system_logs, backup} = require("plugin-core")
var path = require("path")
var cfg_file = path.join(process.env.APPDIR, "plugins", "dropbox-backup", "settings.json")
var { promisify } = require('util')
var fs = require('fs')
var readFile = promisify(fs.readFile)
var script = path.join(__dirname, "backup.sh")
var {spawn} = require('child_process')
var schedule = require('node-schedule');
var job;

exports.init = async()=>{
  await exports.stop()

  var settings;
  try{
    settings = await readFile(cfg_file, 'utf8')
    settings = JSON.parse(settings) || {};
  }catch(e){}
  if(!settings) return
  var { enable_auto_backup, backup_config, backup_database, time, dropbox_access_token } = settings
  if(!(enable_auto_backup && time && dropbox_access_token && (backup_config || backup_database)))
    return

  var [input, h, m, ampm] = time.trim().match(/^(\d+)\s?\:\s?(\d+)\s?(am|pm)$/i)
  if(!h || !m) return

  if(ampm.match(/pm/i))
    h = parseInt(h)+12

  var rule = new schedule.RecurrenceRule();
  rule.dayOfWeek = [new schedule.Range(0, 6)];
  rule.hour = parseInt(h);
  rule.minute = parseInt(m);

  job = schedule.scheduleJob(rule, async function(){
    system_logs.create("info", `Dropbox Backup: Scheduled Job Initiated`).catch(console.log)
    var zip_path = await exports.generateBackup(settings)
    if(!zip_path) return
    await exports.uploadToDropbox(settings, zip_path)
  })
}

exports.stop = ()=>{
  if(job){
    job.cancel()
    job = null
  }
}

exports.generateBackup = async(settings)=>{
  try{
    var {backup_config, backup_database} = settings
    var filename = await backup.createZip({config: backup_config, database: backup_database})
    var zip_path = filename? path.join(process.env.APPDIR, `uploads`, filename) : ""
    return zip_path
  }catch(e){
    system_logs.create("warn", `Dropbox Backup: Error while generating backup`).catch(console.log)
    system_logs.create("critical", `Dropbox Backup: Error while generating backup :\n${e.toString()}`).catch(console.log)
  }
}

exports.uploadToDropbox = async(settings, zip_path)=>{
  try{
    var { dropbox_access_token } = settings
    await new Promise((resolve, reject)=>{
      var exec = spawn(script, [machine_id, dropbox_access_token, zip_path], {shell: true})
  
      var error, resp;
      exec.stderr.on('data', err => {
        if (err){
          error = error? error + '\n' + err.toString() : err.toString()
        }
      })
      exec.on('error', err => {
        error = err.toString()
        reject(error)
      })
      exec.stdout.on('data', function (data) {
        resp += data.toString()
      });
      exec.on('close', code => {
        if(resp.match(/(content_hash|is_downloadable|\"name\")/gi))
          resolve(code)
        else reject(error+"\n"+resp)
      })
    })

    fs.unlink(zip_path, (err) => {
      if (err) return
    })

    system_logs.create("info", `Dropbox Backup: Successfully uploaded`).catch(console.log)
  }catch(e){
    system_logs.create("warn", `Dropbox Backup: Error while uploading to Dropbox`).catch(console.log)
    system_logs.create("critical", `Dropbox Backup: Error while uploading to Dropbox :\n${e.toString()}`).catch(console.log)
  }
}