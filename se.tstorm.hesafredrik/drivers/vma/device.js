'use strict';

const { Device } = require('homey');
const axios = require('axios');

class MyDevice extends Device {

  testUrlRoot = 'https://vmaapi.sr.se/testapi/v2/alerts/';
  urlRoot = 'https://vmaapi.sr.se/api/v2/alerts/';
  incidents = this.getStoreValue('incidents') || [];
  onoff = this.getStoreValue('onoff') || true;
  vmaTimer = null;
  device = null;

  debug = false;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.device = this;
    if (!this.hasCapability('message')) await this.addCapability('message');

    this.log('VMA device has been initialized');
    this.log('Name:', this.getName());
    this.log('Id:', this.getData().id);

    this.registerCapabilityListener('onoff', async (value) => {
      this.log('onoff:', value);
      await this.setStoreValue('onoff', value);
    });

    await this.setCapabilityValue('onoff', this.onoff);

    await this.getAlerts();
    this.vmaTimer = setInterval(async () => {
      await this.getAlerts();
    }, 60000);
  }

  async getAlerts() {
    try {
      const onoff = await this.getCapabilityValue('onoff');
      if (!onoff) return;

      let url = `${this.urlRoot}${this.getData().id}/index.json`;

      if (this.debug) {
        this.log('Debug mode is on, using test URL');
        url = `${this.testUrlRoot}index.json`;
      }
      this.log(url);
      axios.defaults.headers.common['User-Agent'] = 'Homey Hesa Fredrik (https://apps.athom.com/app/se.tstorm.hesafredrik)';
      const response = await axios.get(url);
      const json = response.data;

      if (json.alerts) {
        json.alerts.forEach(async (alert) => {
          const incidentId = alert.incidents;
          this.log(alert);
          if (alert.msgType === 'Alert' && !this.incidents[incidentId]) {
            this.log(`Incident ${incidentId} triggered`);
            this.log(alert.info);

            if (this.incidents[incidentId] !== alert.info) {
              this.incidents[incidentId] = alert.info;
              await this.setStoreValue('incidents', this.incidents);
              await this.setCapabilityValue('message', alert.info[0].description);
              this.driver.triggerVMA(this.device, { message: alert.info[0].description, test: alert.status === 'Test' }, {});
            }
          } else if (alert.msgType === 'Cancel' && this.incidents[incidentId]) {
            this.log(`Incident ${incidentId} cancelled`);
            delete this.incidents[incidentId];
            await this.setStoreValue('incidents', this.incidents);
          }
        });
      }

      this.setCapabilityValue('alarm_generic', Object.keys(this.incidents).length > 0);
      if (Object.keys(this.incidents).length === 0) await this.setCapabilityValue('message', null);

      this.log('Incidents:', this.incidents);
    } catch (error) {
      this.log('Error fetching JSON:', error);
    }
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('VMA device has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('VMA device settings where changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log('VMA device was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('VMA has been deleted');
    clearInterval(this.vmaTimer);
  }

}

module.exports = MyDevice;
