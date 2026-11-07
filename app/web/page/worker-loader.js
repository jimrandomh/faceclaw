// First script of every app worker: wait for the snapshot the app's module
// evaluation reads (settings, asset location; see app/web/workers.ts), then run
// the bundle, which installs the real onmessage before the queue resumes.
self.onmessage = function (event) {
  self.onmessage = null;
  self.__faceclawBoot = event.data;
  importScripts(event.data.bundleUrl);
};
