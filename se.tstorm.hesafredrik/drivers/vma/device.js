'use strict';

const { Device } = require('homey');

class MyDevice extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    try {
      this.log('=== VMA onInit starting ===');

      // Initialize instance properties
      this.incidents = {};
      this.onoff = null;

      // Migrate incidents from array to object if needed
      this.log('Migrating incidents data...');
      await this.migrateIncidentsData();
      this.log('Migration complete');

      // Initialize onoff from store or default to true
      this.log('Getting onoff state...');
      this.onoff = await this.getStoreValue('onoff');
      if (this.onoff === null) {
        this.onoff = true;
        await this.setStoreValue('onoff', true);
      }
      this.log('onoff state:', this.onoff);

      if (!this.hasCapability('message')) {
        this.log('Adding message capability');
        await this.addCapability('message');
      }

      this.log('VMA device has been initialized');
      this.log('Name:', this.getName());
      this.log('Id:', this.getData().id);

      // Simple capability listener - just save the value
      this.registerCapabilityListener('onoff', async (value) => {
        this.log('onoff:', value);
        this.onoff = value;
        await this.setStoreValue('onoff', value);

        // Request an immediate update from the app when device is turned on
        if (value) {
          this.log('Device turned on, requesting alerts update...');
          // Trigger app to fetch and distribute alerts
          setTimeout(() => {
            this.homey.app.fetchAndDistributeAlerts().catch((err) => {
              this.error('Failed to fetch alerts on device enable:', err);
            });
          }, 100);
        }
      });

      // Set initial capability value
      this.log('Setting initial capability value...');
      await this.setCapabilityValue('onoff', this.onoff);

      this.log('=== VMA onInit completed successfully ===');
    } catch (error) {
      this.error('=== FATAL ERROR in onInit ===');
      this.error('Error:', error);
      this.error('Stack:', error.stack);
      throw error;
    }
  }

  /**
   * Process alerts received from the app
   * @param {Array} alerts - Array of alert objects filtered for this device's area
   * @returns {Promise<void>}
   */
  async processAlerts(alerts) {
    const settings = this.getSettings();
    const testMode = settings.test_mode || false;

    this.log('=== processAlerts called ===');
    this.log('Number of alerts:', alerts.length);

    try {
      const onoff = await this.getCapabilityValue('onoff');

      if (!onoff) {
        this.log('Device is turned off, not processing alerts');
        return;
      }

      if (alerts.length > 0) {
        this.log('Processing alerts array...');
        // Use for...of instead of forEach to properly handle async operations
        for (const alert of alerts) {
          const incidentId = alert.incidents;
          // Log full alert details for debugging
          this.log('Processing alert:', JSON.stringify(alert));
          this.log(`Alert: ID=${incidentId}, Type=${alert.msgType}, Status=${alert.status}`);
          this.log('Current incidents:', JSON.stringify(Object.keys(this.incidents)));

          // Filter based on status:
          // "Actual" = real public announcements (always show)
          // "Exercise" = quarterly siren tests (show with indicator)
          // "Test" = system tests (only show if test_mode is enabled)
          if (alert.status === 'Test' && !testMode) {
            this.error('WARNING: Received Test alert in production mode - app filtering failed');
            continue;
          }

          if (alert.msgType === 'Alert' && !this.incidents[incidentId]) {
            this.log(`Incident ${incidentId} triggered`);
            this.log(alert.info);

            // Store the full alert data for richer information
            this.incidents[incidentId] = alert;
            await this.setStoreValue('incidents', this.incidents);

            // Get the best language info based on Homey's locale
            const alertInfo = this.getBestLanguageInfo(alert.info);

            if (alertInfo) {
              // Create a rich message with severity and area information
              const message = this.formatAlertMessage(alertInfo, alert.status);

              try {
                await this.setCapabilityValue('message', message);
              } catch (err) {
                this.error(`Failed to set message capability: ${err.message}`);
              }

              // Trigger with more detailed tokens for flows
              const tokens = {
                message,
                description: alertInfo.description,
                severity: alertInfo.severity,
                urgency: alertInfo.urgency,
                event: alertInfo.event,
                area: alertInfo.areaDesc || alertInfo.area?.[0]?.areaDesc || '',
                status: alert.status,
                exercise: alert.status === 'Exercise',
                test: alert.status === 'Test',
              };

              this.driver.triggerVMA(this, tokens, {});
            } else {
              this.error('No suitable language info found in alert');
            }
          } else if (alert.msgType === 'Cancel' && this.incidents[incidentId]) {
            this.log(`Incident ${incidentId} cancelled`);

            // Get the stored incident data before deleting
            const cancelledIncident = this.incidents[incidentId];
            const alertInfo = this.getBestLanguageInfo(cancelledIncident.info);

            // Trigger cancellation flow
            if (alertInfo) {
              const cancelTokens = {
                message: this.formatAlertMessage(alertInfo, cancelledIncident.status),
                area: alertInfo.areaDesc || alertInfo.area?.[0]?.areaDesc || '',
                incident_id: incidentId,
              };
              this.driver.triggerVMACancel(this, cancelTokens, {});
            }

            // Remove the incident from storage
            delete this.incidents[incidentId];
            await this.setStoreValue('incidents', this.incidents);
          }
        }
      }

      try {
        await this.setCapabilityValue('alarm_generic', Object.keys(this.incidents).length > 0);
      } catch (err) {
        this.error(`Failed to set alarm_generic capability: ${err.message}`);
      }

      if (Object.keys(this.incidents).length === 0) {
        try {
          await this.setCapabilityValue('message', null);
        } catch (err) {
          this.error(`Failed to clear message capability: ${err.message}`);
        }
      }

      this.log('=== processAlerts completed successfully ===');

    } catch (error) {
      this.error('=== Error processing alerts ===');
      this.error('Error message:', error.message);
      this.error('Error:', error);
    }
  }

  /**
   * Get the best language info object based on Homey's locale
   * @param {Array} infoArray - Array of info objects with different languages
   * @returns {Object|null} The best matching info object
   */
  getBestLanguageInfo(infoArray) {
    if (!infoArray || !Array.isArray(infoArray) || infoArray.length === 0) {
      return null;
    }

    // Get Homey's language (defaults to 'en' if not available)
    const homeyLanguage = this.homey.i18n?.getLanguage?.() || 'sv';

    // Try to find exact language match
    let info = infoArray.find((i) => i.language?.toLowerCase().startsWith(homeyLanguage.toLowerCase()));

    // Fallback to Swedish if no match (since this is a Swedish emergency system)
    if (!info) {
      info = infoArray.find((i) => i.language?.toLowerCase().startsWith('sv'));
    }

    // Final fallback to first available
    if (!info) {
      info = infoArray[0];
    }

    return info;
  }

  /**
   * Format an alert message with severity and area information
   * @param {Object} alertInfo - The alert info object
   * @param {string} status - The alert status (Actual/Exercise/Test)
   * @returns {string} Formatted message
   */
  formatAlertMessage(alertInfo, status) {
    // Return plain description - users can use flow tokens for additional formatting
    return alertInfo.description || alertInfo.event || 'VMA Alert';
  }

  /**
   * Migrate incidents data from array to object structure
   */
  async migrateIncidentsData() {
    const storedIncidents = await this.getStoreValue('incidents');

    if (storedIncidents === null || storedIncidents === undefined) {
      // No stored data, initialize as empty object
      this.incidents = {};
    } else if (Array.isArray(storedIncidents)) {
      // Old array format, migrate to object
      this.log('Migrating incidents from array to object format');
      this.incidents = {};

      // If there were items in the array, try to preserve them
      // (though the old code was using it incorrectly as an object anyway)
      if (storedIncidents.length > 0) {
        this.log('Warning: Found array-stored incidents, attempting migration');
      }

      // Save the migrated structure
      await this.setStoreValue('incidents', this.incidents);
    } else if (typeof storedIncidents === 'object') {
      // Already in correct format
      this.incidents = storedIncidents;
    } else {
      // Unknown format, reset to empty object
      this.log('Unknown incidents format, resetting to empty object');
      this.incidents = {};
      await this.setStoreValue('incidents', this.incidents);
    }
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('=== VMA onAdded called ===');
    this.log('Device name:', this.getName());
    this.log('Device data:', this.getData());
    this.log('VMA device has been added successfully');

    // Reconfigure SSE connections since a new device may change endpoint needs
    this.log('Reconfiguring SSE connections after device added...');
    this.homey.app.setupSSEConnections();

    // Trigger immediate fetch to get alerts for this new device
    this.log('Triggering immediate fetch for new device...');
    await this.homey.app.fetchAndDistributeAlerts().catch((err) => {
      this.error('Failed to fetch alerts for new device:', err);
    });
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
    this.log('=== VMA device settings were changed ===');
    this.log('Old settings:', JSON.stringify(oldSettings));
    this.log('New settings:', JSON.stringify(newSettings));
    this.log('Changed keys:', changedKeys);

    // If test_mode was changed, trigger app to reconnect SSE connections
    if (changedKeys.includes('test_mode')) {
      this.log(`Test mode changed from ${oldSettings.test_mode} to ${newSettings.test_mode}`);
      this.log('Device will now use:', newSettings.test_mode ? 'TEST API' : 'PRODUCTION API');

      // Clear current incidents when switching modes
      this.log('Clearing incidents due to test_mode change...');
      this.incidents = {};
      await this.setStoreValue('incidents', this.incidents);

      // Update capability values to reflect cleared state
      try {
        await this.setCapabilityValue('alarm_generic', false);
        await this.setCapabilityValue('message', null);
        this.log('Capabilities cleared successfully');
      } catch (err) {
        this.error('Failed to clear capabilities:', err);
      }

      // Reconfigure SSE connections based on new device settings
      this.log('Reconfiguring SSE connections after test_mode change...');
      this.homey.app.setupSSEConnections();

      // Force an immediate fetch to test the new setting
      this.log('Forcing immediate fetch after test_mode change...');
      await this.homey.app.fetchAndDistributeAlerts();
    }
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

    // Trigger SSE reconfiguration since device needs may have changed
    this.homey.app.setupSSEConnections();
  }

}

module.exports = MyDevice;
