"use strict";

function computeBackgroundColorFrom(element, classList) {
  var div = document.createElement('div');
  var classes = classList.split('.');
  for (var i = 0; i < classes.length; ++i)
    div.classList.add(classes[i]);
  element.appendChild(div);
  var color = window.getComputedStyle(div).backgroundColor;
  element.removeChild(div);
  return color;
}

// This class reads the format of ACT Timeline plugin, described in
// data/timelines/README.txt.
class Timeline {
  constructor(text, options) {
    this.options = options;
    // A set of names which will not be notified about.
    this.ignores = {};
    // Sorted by event occurance time.
    this.events = [];
    // Sorted by event occurance time.
    this.texts = [];
    // Sorted by sync.start time.
    this.syncStarts = [];
    // Sorted by sync.end time.
    this.syncEnds = [];
    // Not sorted.
    this.activeSyncs = [];
    // Sorted by event occurance time.
    this.activeEvents = [];
    this.LoadFile(text);
    this.Stop();
  }
    
  LoadFile(text) {
    this.events = [];
    this.syncStarts = [];
    this.syncEnds = [];
    
    var uniqueid = 1;
    var texts = {};
    
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; ++i) {
      var line = lines[i];
      // Drop comments.
      var comment = line.indexOf('#');
      if (comment >= 0)
        line = line.substring(0, comment);
      line = line.trim();

      var match = line.match(/^hideall\s+\"([^"]+)\"$/);
      if (match != null) {
        this.ignores[match[1]] = true;
        continue;
      }

      match = line.match(/^(info|alert|alarm)text\s+\"([^"]+)\"\s+before\s+(-?[0-9]+(?:\.[0-9]+)?)(?:\s+\"([^"]+)\")?$/)
      if (match != null) {
        texts[match[2]] = texts[match[2]] || [];
        texts[match[2]].push({
          type: match[1],
          secondsBefore: parseFloat(match[3]),
          text: match[4] ? match[4] : match[2],
        });
        continue;
      }
      
      match = line.match(/^([0-9]+(?:\.[0-9]+)?)\s+"(.*?)"(\s+(.*))?/);
      if (match == null) continue;
      
      var seconds = parseFloat(match[1]);
      var e = {
        id: uniqueid++,
        time: seconds,
        sortTime: seconds,
        name: match[2],
        activeTime: 0,
      };
      var commands = match[3];
      if (commands) {
        var commandMatch = commands.match(/duration\s+([0-9]+(?:\.[0-9]+)?)(\s.*)?$/);
        if (commandMatch)
          e.duration = parseFloat(commandMatch[1]);
        commandMatch = commands.match(/sync\s+\/(.*)\/(\s.*)?$/);
        if (commandMatch) {
          var sync = {
            id: uniqueid,
            regex: Regexes.Parse(commandMatch[1]),
            start: seconds - 2.5,
            end: seconds + 2.5,
            time: seconds,
          }
          if (commandMatch[2]) {
            var argMatch = commandMatch[2].match(/window\s+(([0-9]+(?:\.[0-9]+)?),)?([0-9]+(?:\.[0-9]+)?)(\s.*)?$/);
            if (argMatch) {
              if (argMatch[2]) {
                sync.start = seconds - parseFloat(argMatch[2]);
                sync.end = seconds + parseFloat(argMatch[3]);
              } else {
                sync.start = seconds - (parseFloat(argMatch[3]) / 2);
                sync.end = seconds + (parseFloat(argMatch[3]) / 2);
              }
            }
            argMatch = commandMatch[2].match(/jump\s+([0-9]+(?:\.[0-9]+)?)(\s.*)?$/);
            if (argMatch)
              sync.jump = parseFloat(argMatch[1]);
          }
          this.syncStarts.push(sync);
          this.syncEnds.push(sync);
        }
      }
      this.events.push(e);
    }

    for (var i = 0; i < this.events.length; ++i) {
      var e = this.events[i];
      if (e.name in texts) {
        for (var j = 0; j < texts[e.name].length; ++j) {
          var matchedTextEvent = texts[e.name][j];
          var t = {
            type: matchedTextEvent.type,
            time: e.time - matchedTextEvent.secondsBefore,
            text: matchedTextEvent.text,
          };
          this.texts.push(t);
        }
      }
    }
    
    this.events.sort(function(a, b) { return a.time - b.time });
    this.texts.sort(function(a, b) { return a.time - b.time });
    this.syncStarts.sort(function(a, b) { return a.start - b.start });
    this.syncEnds.sort(function(a, b) { return a.end - b.end });
  }
  
  Stop() {
    this.timebase = null;

    this.nextEvent = 0;
    this.nextText = 0;
    this.nextSyncStart = 0;
    this.nextSyncEnd = 0;

    var fightNow = 0;
    this._AdvanceTimeTo(fightNow);
    this._CollectActiveSyncs(fightNow);

    this._ClearTimers();
    this._CancelUpdate();

    if (this.syncTimeCallback)
      this.syncTimeCallback(fightNow, false);
  }

  SyncTo(fightNow) {
    // This records the actual time which aligns with "0" in the timeline.
    this.timebase = new Date(new Date() - fightNow * 1000);
    
    this.nextEvent = 0;
    this.nextText = 0;
    this.nextSyncStart = 0;
    this.nextSyncEnd = 0;

    // This will skip text events without running them.
    this._AdvanceTimeTo(fightNow);
    this._CollectActiveSyncs(fightNow);

    this._ClearTimers();
    this._AddUpcomingTimers(fightNow);
    this._CancelUpdate();
    this._ScheduleUpdate(fightNow);

    if (this.syncTimeCallback)
      this.syncTimeCallback(fightNow, true);
  }
  
  _CollectActiveSyncs(fightNow) {
    this.activeSyncs = [];
    for (var i = this.nextSyncEnd; i < this.syncEnds.length; ++i) {
      if (this.syncEnds[i].start <= fightNow)
        this.activeSyncs.push(this.syncEnds[i]);
    }
  }
  
  OnLogLine(line) {
    for (var i = 0; i < this.activeSyncs.length; ++i) {
      var sync = this.activeSyncs[i];
      if (line.search(sync.regex) >= 0) {
        if ('jump' in sync) {
          if (!sync.jump)
            this.Stop();
          else
            this.SyncTo(sync.jump);
        } else {
          this.SyncTo(sync.time);
        }
        break;
      }
    }
  }
  
  _AdvanceTimeTo(fightNow) {
    while (this.nextEvent < this.events.length && this.events[this.nextEvent].time <= fightNow)
      ++this.nextEvent;
    while (this.nextText < this.texts.length && this.texts[this.nextText].time <= fightNow)
      ++this.nextText;
    while (this.nextSyncStart < this.syncStarts.length && this.syncStarts[this.nextSyncStart].start <= fightNow)
      ++this.nextSyncStart;
    while (this.nextSyncEnd < this.syncEnds.length && this.syncEnds[this.nextSyncEnd].end <= fightNow)
      ++this.nextSyncEnd;
  }
  
  _ClearTimers() {
    if (this.removeTimerCallback) {
      for (var i = 0; i < this.activeEvents.length; ++i)
        this.removeTimerCallback(this.activeEvents[i], false);
    }
    this.activeEvents = [];
  }

  _RemoveExpiredTimers(fightNow) {
    while (this.activeEvents.length && this.activeEvents[0].time <= fightNow) {
      if (this.removeTimerCallback)
        this.removeTimerCallback(this.activeEvents[0], true);
      this.activeEvents.splice(0, 1);
    }
  }
  
  _AddDurationTimers(fightNow) {
    var sort = false;
    var events = [];
    for (var i = 0; i < this.activeEvents.length; ++i) {
      var e = this.activeEvents[i];
      if (e.time <= fightNow && e.duration) {
        var durationEvent = {
          id: e.id,
          time: e.time + e.duration,
          sortTime: e.time,
          name: 'Active: ' + e.name,
        };
        events.push(durationEvent);
        this.activeEvents.splice(i, 1);
        if (this.addTimerCallback)
          this.addTimerCallback(fightNow, durationEvent, true);
        sort = true;
        --i;
      }
    }
    if (events.length)
      Array.prototype.push.apply(this.activeEvents, events);
      this.activeEvents.sort(function(a, b) { return a.time - b.time });
  }
  
  _AddUpcomingTimers(fightNow) {
    while (this.nextEvent < this.events.length && this.activeEvents.length < this.options.MaxNumberOfTimerBars) {
      var e = this.events[this.nextEvent];
      if (e.time - fightNow > this.options.ShowTimerBarsAtSeconds)
        break;
      if (fightNow < e.time && !(e.name in this.ignores)) {
        this.activeEvents.push(e);
        if (this.addTimerCallback)
          this.addTimerCallback(fightNow, e, false);
      }
      ++this.nextEvent;
    }
  }

  _AddPassedTexts(fightNow) {
    while (this.nextText < this.texts.length) {
      var t = this.texts[this.nextText];
      if (t.time > fightNow)
        break;
      if (t.type == 'info') {
        if (this.showInfoTextCallback)
          this.showInfoTextCallback(t.text);
      } else if (t.type == 'alert') {
        if (this.showAlertTextCallback)
          this.showAlertTextCallback(t.text);
      } else if (t.type == 'alarm') {
        if (this.showAlarmTextCallback)
          this.showAlarmTextCallback(t.text);
      }
      ++this.nextText;
    }
  }

  _CancelUpdate() {
    if (this.updateTimer) {
      window.clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
  }
  
  _ScheduleUpdate(fightNow) {
    console.assert(this.timebase, "_ScheduleUpdate called while stopped");

    var kBig = 1000000000; // Something bigger than any fight length in seconds.
    var nextEventStarting = kBig;
    var nextTextOccurs = kBig;
    var nextEventEnding = kBig;
    var nextSyncStarting = kBig;
    var nextSyncEnding = kBig;
    
    if (this.nextEvent < this.events.length) {
      var nextEventEndsAt = this.events[this.nextEvent].time
      console.assert(nextEventStarting > fightNow, "nextEvent wasn't updated before calling _ScheduleUpdate")
      // There might be more events than we can show, so the next event might be in
      // the past. If that happens, then ignore it, as we can't use that for our timer.
      var showNextEventAt = nextEventEndsAt - this.options.ShowTimerBarsAtSeconds;
      if (showNextEventAt > fightNow)
        nextEventStarting = showNextEventAt;
    }
    if (this.nextText < this.texts.length) {
      nextTextOccurs = this.texts[this.nextText].time;
      console.assert(nextTextOccurs > fightNow, "nextText wasn't updated before calling _ScheduleUpdate")
    }
    if (this.activeEvents.length > 0) {
      nextEventEnding = this.activeEvents[0].time;
      console.assert(nextEventEnding > fightNow, "Expired activeEvents weren't pruned before calling _ScheduleUpdate")
    }
    if (this.nextSyncStart < this.syncStarts.length) {
      nextSyncStarting = this.syncStarts[this.nextSyncStart].start;
      console.assert(nextSyncStarting > fightNow, "nextSyncStart wasn't updated before calling _ScheduleUpdate")
    }
    if (this.nextSyncEnd < this.syncEnds.length) {
      nextSyncEnding = this.syncEnds[this.nextSyncEnd].end;
      console.assert(nextSyncEnding > fightNow, "nextSyncEnd wasn't updated before calling _ScheduleUpdate")
    }
    
    var nextTime = Math.min(nextEventStarting, Math.min(nextEventEnding, Math.min(nextTextOccurs, Math.min(nextSyncStarting, nextSyncEnding))));
    if (nextTime != kBig) {
      console.assert(nextTime > fightNow, "nextTime is in the past")
      this.updateTimer = window.setTimeout(this._OnUpdateTimer.bind(this), (nextTime - fightNow) * 1000);
    }
  }
  
  _OnUpdateTimer() {
    console.assert(this.timebase, "_OnTimerUpdate called while stopped");

    // This is the number of seconds into the fight (subtracting Dates gives milliseconds).
    var fightNow = (new Date() - this.timebase) / 1000;
    // Send text events now or they'd be skipped by _AdvanceTimeTo().
    this._AddPassedTexts(fightNow, true);
    this._AdvanceTimeTo(fightNow);
    this._CollectActiveSyncs(fightNow);

    this._AddDurationTimers(fightNow);
    this._RemoveExpiredTimers(fightNow);
    this._AddUpcomingTimers(fightNow);
    this._ScheduleUpdate(fightNow);
  }

  SetAddTimer(c) { this.addTimerCallback = c; }
  SetRemoveTimer(c) { this.removeTimerCallback = c; }
  SetShowInfoText(c) { this.showInfoTextCallback = c; }
  SetShowAlertText(c) { this.showAlertTextCallback = c; }
  SetShowAlarmText(c) { this.showAlarmTextCallback = c; }
  SetSyncTime(c) { this.syncTimeCallback = c; }
};

class TimelineUI {
  constructor(options) {
    this.options = options;
    this.init = false;
  }
  
  Init() {
    if (this.init) return;
    this.init = true;

    this.root = document.getElementById('timeline-container');

    this.barWidth = window.getComputedStyle(this.root).width;
    var windowHeight = parseFloat(window.getComputedStyle(this.root).height.match(/([0-9.]+)px/)[1]);
    this.barHeight = windowHeight / this.options.MaxNumberOfTimerBars - 2;

    this.barColor =  computeBackgroundColorFrom(this.root, 'timeline-bar-color');
    this.barExpiresSoonColor = computeBackgroundColorFrom(this.root, 'timeline-bar-color.soon');

    this.timerlist = document.getElementById('timeline');
    this.timerlist.maxnumber = this.options.MaxNumberOfTimerBars;
    this.timerlist.rowcolsize = this.options.MaxNumberOfTimerBars;
    this.timerlist.elementwidth = this.barWidth;
    this.timerlist.elementheight = this.barHeight + 2;
    this.timerlist.toward = "down right";

    // Helper for positioning/resizing when locked.
    var helper = document.getElementById('timeline-resize-helper');
    for (var i = 0; i < this.options.MaxNumberOfTimerBars; ++i) {
      var helperBar = document.createElement('div');
      helperBar.classList.add('text');
      helperBar.classList.add('resize-helper-bar');
      helperBar.classList.add('timeline-bar-color');
      if (i < 1)
        helperBar.classList.add('soon');
      helperBar.innerText = 'Test bar ' + (i + 1);
      helper.appendChild(helperBar);
      var borderWidth = parseFloat(window.getComputedStyle(helperBar).borderWidth.match(/([0-9.]+)px/)[1]);
      helperBar.style.width = this.barWidth - borderWidth * 2;
      helperBar.style.height = this.barHeight - borderWidth * 2;
    }

    this.debugElement = document.getElementById('timeline-debug');

    this.activeBars = {};
    this.expireTimers = {};
  }

  SetPopupTextInterface(popupText) {
    this.popupText = popupText;
  }

  SetTimeline(timeline) {
    this.Init();
    if (this.timeline) {
      this.timeline.SetAddTimer(null);
      this.timeline.SetRemoveTimer(null);
      this.timeline.SetShowInfoText(null);
      this.timeline.SetShowAlertText(null);
      this.timeline.SetShowAlarmText(null);
      this.timeline.SetSyncTime(null);
      this.timerlist.clear();
      this.debugElement.innerHTML = '';
      this.debugFightTimer = null;
      this.activeBars = {};
    }

    this.timeline = timeline;
    if (this.timeline) {
      this.timeline.SetAddTimer(this.OnAddTimer.bind(this));
      this.timeline.SetRemoveTimer(this.OnRemoveTimer.bind(this));
      this.timeline.SetShowInfoText(this.OnShowInfoText.bind(this));
      this.timeline.SetShowAlertText(this.OnShowAlertText.bind(this));
      this.timeline.SetShowAlarmText(this.OnShowAlarmText.bind(this));
      this.timeline.SetSyncTime(this.OnSyncTime.bind(this));
    }
  }
  
  OnAddTimer(fightNow, e, channeling) {
    var div = document.createElement('div');
    var bar = document.createElement('timer-bar');
    div.appendChild(bar);
    bar.width = this.barWidth;
    bar.height = this.barHeight;
    bar.duration = channeling ? e.time - fightNow : this.options.ShowTimerBarsAtSeconds;
    bar.value = e.time - fightNow;
    bar.righttext = 'remain';
    bar.lefttext = e.name;
    bar.toward = 'right';
    bar.style = !channeling ? 'fill' : 'empty';

    if (!channeling && e.time - fightNow > this.options.BarExpiresSoonSeconds) {
      bar.fg = this.barColor;
      window.setTimeout(this.OnTimerExpiresSoon.bind(this, e.id), (e.time - fightNow - this.options.BarExpiresSoonSeconds) * 1000);
    } else {
      bar.fg = this.barExpiresSoonColor;
    }

    this.timerlist.addElement(e.id, div, e.sortTime);
    this.activeBars[e.id] = bar;
    if (e.id in this.expireTimers) {
      window.clearTimeout(this.expireTimers[e.id])
      delete this.expireTimers[e.id];
    }
  }
  
  OnTimerExpiresSoon(id) {
    if (id in this.activeBars)
      this.activeBars[id].fg = this.barExpiresSoonColor;
  }
  
  OnRemoveTimer(e, expired) {
    if (expired && this.options.KeepExpiredTimerBarsForSeconds) {
      this.expireTimers[e.id] = window.setTimeout(this.OnRemoveTimer.bind(this, e, false), this.options.KeepExpiredTimerBarsForSeconds * 1000);
      return;
    } else if (e.id in this.expireTimers) {
      window.clearTimeout(this.expireTimers[e.id])
      delete this.expireTimers[e.id];
    }
    this.timerlist.removeElement(e.id);
    delete this.activeBars[e.id];
  }

  OnShowInfoText(text) {
    if (this.popupText)
      this.popupText.Info(text);
  }

  OnShowAlertText(text) {
    if (this.popupText)
      this.popupText.Alert(text);
  }

  OnShowAlarmText(text) {
    if (this.popupText)
      this.popupText.Alarm(text);
  }

  OnSyncTime(fightNow, running) {
    if (!this.options.Debug)
      return;

    if (!running) {
      if (this.debugFightTimer)
        this.debugElement.removeChild(this.debugFightTimer);
      delete this.debugFightTimer;
      return;
    }

    if (!this.debugFightTimer) {
      this.debugFightTimer = document.createElement('timer-bar');
      this.debugFightTimer.width = this.barWidth;
      this.debugFightTimer.height = this.barHeight;
      this.debugFightTimer.duration = 10000; // anything big
      this.debugFightTimer.lefttext = 'elapsed';
      this.debugFightTimer.toward = 'right';
      this.debugFightTimer.style = 'fill';
      this.debugFightTimer.bg = 'transparent';
      this.debugFightTimer.fg = 'transparent';
      this.debugElement.appendChild(this.debugFightTimer);
      console.log('OnSync: ' + fightNow + ' (init)');
    } else {
      console.log('OnSync: ' + fightNow +
          ' (prev: ' + this.debugFightTimer.elapsed + ')');
    }

    // Force this to be reset.
    this.debugFightTimer.elapsed = 0;
    this.debugFightTimer.elapsed = fightNow;
  }
};

class TimelineController {
  constructor(options, ui) {
    this.options = options;
    this.ui = ui;
    this.dataFiles = {};
    this.timelines = [];
  }

  SetPopupTextInterface(popupText) {
    this.ui.SetPopupTextInterface(popupText);
  }

  OnInCombat(e) {
    if (!e.detail.inCombat && !this.inBossFight)
      this.OnBossFightStop();
  }
  
  OnBossFightStart() {
    this.inBossFight = true;
  }

  OnBossFightStop() {
    this.inBossFight = false;
    if (this.activeTimeline)
      this.activeTimeline.Stop();
  }

  OnLogEvent(e) {
    if (!this.activeTimeline)
      return;
    for (var i = 0; i < e.detail.logs.length; ++i)
      this.activeTimeline.OnLogLine(e.detail.logs[i]);
  }

  OnZoneChanged(e) {
    this.activeTimeline = null;

    if (!this.options.TimelineEnabled)
      return;

    var text = '';
    // Get the first matching timeline file.
    for (var i = 0; i < this.timelines.length; ++i) {
      if (e.detail.zoneName.search(this.timelines[i].zoneRegex) >= 0) {
        text = this.timelines[i].text;
        break;
      }
    }
    // Append text from user-defined timelines.
    for (var i = 0; i < this.options.Timelines.length; ++i) {
      if (e.detail.zoneName.search(this.options.Timelines[i].zoneRegex) >= 0) {
        if (!this.options.Timelines[i].timeline)
          console.log("Missing 'timeline' in user-defined timeline for " + this.options.Timelines[i].zoneRegex);
        else
          text = text + '\n' + this.options.Timelines[i].timeline;
      }
    }

    if (text)
      this.activeTimeline = new Timeline(text, this.options);
    this.ui.SetTimeline(this.activeTimeline);
  }

  SetDataFiles(files) {
    this.timelines = [];
    for (var f in files) {
      // Reads from the data/timelines/ directory.
      if (!f.startsWith('timelines/'))
        continue;

      var zoneRegex = f;
      // Drop the file extension.
      if (zoneRegex.indexOf('.') >= 0)
        zoneRegex = zoneRegex.split('.').slice(0, -1).join('.');
      // Drop leading directory names.
      if (zoneRegex.indexOf('/') >= 0)
        zoneRegex = zoneRegex.split('/').slice(-1)[0];
      // Escape regex special characters.
      zoneRegex.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '\\$&');

      var lines = files[f].split('\n');
      for (var i = 0; i < lines.length; ++i) {
        var line = lines[i].trim();
        var match = line.match(/^zone \"([^"]+)\"(?:\s+#.*)?$/);
        if (match != null)
          zoneRegex = match[1];
      }

      this.timelines.push({
        zoneRegex: new RegExp(zoneRegex),
        text: files[f],
      });
    }
  }
}

var gTimelineController;

document.addEventListener("onZoneChangedEvent", function(e) {
  gTimelineController.OnZoneChanged(e);
});
document.addEventListener("onInCombatChangedEvent", function (e) {
  gTimelineController.OnInCombat(e);
});
document.addEventListener("onBossFightStart", function(e) {
  gTimelineController.OnBossFightStart();
});
document.addEventListener("onBossFightEnd", function(e) {
  gTimelineController.OnBossFightStop();
});
document.addEventListener("onLogEvent", function(e) {
  gTimelineController.OnLogEvent(e);
});
document.addEventListener("onDataFilesRead", function(e) {
  gTimelineController.SetDataFiles(e.detail.files);
});
