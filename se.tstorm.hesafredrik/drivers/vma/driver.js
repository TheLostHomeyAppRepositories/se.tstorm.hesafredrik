/* eslint-disable quote-props */

'use strict';

const { Driver } = require('homey');
const { AreaCodes } = require('./areacodes');

class MyDriver extends Driver {

  pairingCounty = null;

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('VMA driver has been initialized');

    this._vma_trigger = this.homey.flow.getDeviceTriggerCard('vma_trigger');
    this._vma_cancel_trigger = this.homey.flow.getDeviceTriggerCard('vma_cancel_trigger');

    // Register run listener to validate trigger conditions
    // Note: This only runs when a flow actually triggers, not during device pairing
    this._vma_trigger.registerRunListener(async (args, state) => {
      try {
        // Validate if device is on before allowing trigger
        if (args.device) {
          const onoff = await args.device.getCapabilityValue('onoff');
          if (!onoff) {
            this.log('VMA trigger blocked: device is off');
            return false;
          }
        }

        // Validate message exists
        if (!state || !state.message) {
          this.log('VMA trigger blocked: no message in state');
          return false;
        }

        return true;
      } catch (error) {
        this.error('Error in flow run listener:', error);
        return false;
      }
    });

    // Register run listener for cancellation trigger
    this._vma_cancel_trigger.registerRunListener(async (args, state) => {
      try {
        // Validate if device is on before allowing trigger
        if (args.device) {
          const onoff = await args.device.getCapabilityValue('onoff');
          if (!onoff) {
            this.log('VMA cancel trigger blocked: device is off');
            return false;
          }
        }

        return true;
      } catch (error) {
        this.error('Error in flow cancel run listener:', error);
        return false;
      }
    });
  }

  triggerVMA(device, tokens, state) {
    this._vma_trigger
      .trigger(device, tokens, state)
      .catch(this.error);
  }

  triggerVMACancel(device, tokens, state) {
    this._vma_cancel_trigger
      .trigger(device, tokens, state)
      .catch(this.error);
  }

  /**
   * onPair is called when the user starts pairing a new device
   * @param {object} session
   * @returns {Promise<void>}
   */
  async onPair(session) {
    this.log('VMA driver onPair');

    session.setHandler('get_counties', async (data) => {
      this.log('VMA driver onPair get_counties');
      const counties = [];

      // Add Sverige (00) first
      if (AreaCodes['00']) {
        counties.push({
          name: AreaCodes['00'].name,
          id: '00',
        });

        // Add visual separator
        counties.push({
          name: '────────────────────────',
          id: 'separator',
        });
      }

      // Add remaining counties sorted by name
      const otherCodes = Object.keys(AreaCodes).filter((code) => code !== '00');
      const sortedCodes = otherCodes.sort((a, b) => {
        return AreaCodes[a].name.localeCompare(AreaCodes[b].name);
      });

      sortedCodes.forEach((code) => {
        const { name } = AreaCodes[code];
        counties.push({
          name,
          id: code,
        });
      });

      return counties;
    });

    session.setHandler('set_county', async (data) => {
      this.log('VMA driver onPair set_county');
      this.log('Received data:', JSON.stringify(data));

      // Ignore empty or separator selection
      if (!data || !data.id || data.id === 'separator' || data.id === '') {
        this.log('Invalid selection, ignoring:', data?.id);
        return;
      }

      this.log(`Setting pairingCounty to: ${data.id}`);
      this.pairingCounty = data.id;
    });

    session.setHandler('showView', async (viewId) => {
      this.log(`View: ${viewId}`);
    });

    session.setHandler('list_devices', async () => {
      this.log('VMA driver onPair list_devices');
      return this.onPairListDevices();
    });
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    this.log('VMA driver onPairListDevices');
    this.log(`pairingCounty is: ${this.pairingCounty}`);
    const devices = [];

    if (this.pairingCounty == null) {
      // Show all counties and municipalities (but exclude "00" which is only accessible via county selection)
      Object.keys(AreaCodes).forEach((code) => {
        if (code === '00') return; // Skip Sverige, must be selected via county list

        // Get code and name
        const { name } = AreaCodes[code];
        const device = {
          name: `VMA ${code} ${name}`,
          data: {
            id: code,
          },
        };
        devices.push(device);
      });
    } else if (this.pairingCounty === '00') {
      // Special case: "00" (Sweden) has no sub-areas, just add the nationwide device
      const device = {
        name: `VMA ${this.pairingCounty} ${AreaCodes[this.pairingCounty].name}`,
        data: {
          id: this.pairingCounty,
        },
      };
      devices.push(device);
    } else {
      Object.keys(AreaCodes[this.pairingCounty]).forEach((code) => {
        if (code === 'name') return;
        // Get code and name
        const name = AreaCodes[this.pairingCounty][code];
        const device = {
          name: `VMA ${code} ${name}`,
          data: {
            id: code,
          },
        };
        devices.push(device);
      });
    }

    return devices;
  }

}

module.exports = MyDriver;
