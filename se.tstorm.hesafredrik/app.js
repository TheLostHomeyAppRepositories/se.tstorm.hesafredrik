'use strict';

const Homey = require('homey');
const { EventSource } = require('eventsource');
const axios = require('axios');

// Configuration constants
const CONFIG = {
  API_URL: 'https://vmaapi.sr.se/api/v3/alerts',
  TEST_API_URL: 'https://vmaapi.sr.se/testapi/v3/alerts',
  SSE_URL: 'https://vmaapi.sr.se/api/v3/subscribe',
  TEST_SSE_URL: 'https://vmaapi.sr.se/testapi/v3/subscribe',
  REQUEST_TIMEOUT: 10000,
  SSE_RECONNECT_DELAY: 5000,
  MAX_BACKOFF_DELAY: 60000,
  FETCH_DEBOUNCE_DELAY: 2000, // Debounce fetch requests by 2 seconds
  SSE_MAX_AGE: 10 * 60 * 1000, // Proactively reconnect SSE after 10 minutes
  SSE_HEALTH_CHECK_INTERVAL: 2 * 60 * 1000, // Check SSE health every 2 minutes
};

class HesaFredrikApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Hesa Fredrik has been initialized');

    // Initialize SSE connection properties for production and test endpoints
    this.productionSSE = {
      eventSource: null,
      connected: false,
      retryCount: 0,
      reconnectTimer: null,
      connectedAt: null,
      createdAt: null,
    };

    this.testSSE = {
      eventSource: null,
      connected: false,
      retryCount: 0,
      reconnectTimer: null,
      connectedAt: null,
      createdAt: null,
    };

    // Initialize SSE health check interval
    this._sseHealthCheckInterval = null;

    // Initialize fetch mutex to prevent concurrent API calls
    this._fetchInProgress = false;

    // Initialize debounce timer for fetch requests
    this._fetchDebounceTimer = null;

    // Initialize circuit breaker for API failures
    this._apiFailureCount = 0;
    this._apiCircuitOpen = false;

    // Defer SSE setup to ensure devices are fully initialized
    // Use setTimeout to let device onInit complete first
    setTimeout(() => {
      this.log('Setting up SSE connections...');
      this.setupSSEConnections();

      // Start SSE health monitoring
      this.startSSEHealthCheck();

      // Perform initial fetch after SSE setup (debounced to avoid conflicts with SSE messages)
      this.log('Scheduling initial fetch of all alerts...');
      this.debouncedFetchAndDistributeAlerts();
    }, 2000);
  }

  /**
   * Check which devices need production vs test endpoints
   * @returns {object} Object with hasProduction and hasTest booleans
   */
  getDeviceEndpointNeeds() {
    try {
      const driver = this.homey.drivers.getDriver('vma');
      const devices = driver.getDevices();

      const hasProduction = devices.some((device) => {
        const settings = device.getSettings();
        return settings.test_mode !== true;
      });

      const hasTest = devices.some((device) => {
        const settings = device.getSettings();
        return settings.test_mode === true;
      });

      return { hasProduction, hasTest };
    } catch (error) {
      this.error('Error checking device endpoint needs:', error);
      return { hasProduction: false, hasTest: false };
    }
  }

  /**
   * Set up SSE connections based on device configuration
   */
  setupSSEConnections() {
    const needs = this.getDeviceEndpointNeeds();

    this.log('SSE connection needs:', needs);

    if (needs.hasProduction) {
      this.setupSSE('production');
    } else {
      this.closeSSE('production');
    }

    if (needs.hasTest) {
      this.setupSSE('test');
    } else {
      this.closeSSE('test');
    }
  }

  /**
   * Set up a single SSE connection (production or test)
   * @param {string} type - 'production' or 'test'
   */
  setupSSE(type) {
    if (type !== 'production' && type !== 'test') {
      this.error(`Invalid SSE type: ${type}`);
      return;
    }

    const sse = type === 'production' ? this.productionSSE : this.testSSE;
    const sseUrl = type === 'production' ? CONFIG.SSE_URL : CONFIG.TEST_SSE_URL;

    // Clean up any existing connection
    if (sse.eventSource) {
      this.log(`Closing existing ${type} SSE connection`);
      sse.eventSource.close();
      sse.eventSource = null;
    }

    // Reset connected flag when setting up a new connection
    sse.connected = false;

    // Clear any reconnection timer
    if (sse.reconnectTimer) {
      clearTimeout(sse.reconnectTimer);
      sse.reconnectTimer = null;
    }

    const setupStartTime = Date.now();
    this.log(`Setting up ${type} SSE connection to ${sseUrl}`);

    try {
      sse.eventSource = new EventSource(sseUrl, {
        headers: {
          'User-Agent': 'Homey Hesa Fredrik (https://apps.athom.com/app/se.tstorm.hesafredrik)',
          Accept: 'text/event-stream',
        },
      });

      sse.createdAt = Date.now();
      this.log(`${type} EventSource created, waiting for onopen event... (readyState: ${sse.eventSource.readyState})`);

      sse.eventSource.onopen = () => {
        const elapsed = Math.round((Date.now() - setupStartTime) / 1000);
        this.log(`${type} SSE connection opened after ${elapsed} seconds`);
        sse.connected = true;
        sse.connectedAt = Date.now();
        sse.retryCount = 0;
      };

      sse.eventSource.onmessage = async (event) => {
        // First message marks connection as established
        if (!sse.connected) {
          this.log(`${type} SSE first message received (connection established)`);
          sse.connected = true;
          sse.connectedAt = Date.now();
        }

        try {
          const data = JSON.parse(event.data);
          this.log(`${type} SSE update received:`, data.message);
          this.debouncedFetchAndDistributeAlerts();
        } catch (error) {
          this.error(`Failed to parse ${type} SSE message:`, error);
        }
      };

      sse.eventSource.onerror = (error) => {
        this.error(`${type} SSE connection error, scheduling reconnection`);
        this.scheduleReconnection(type);
      };

    } catch (error) {
      this.error(`=== Failed to setup ${type} SSE connection ===`);
      this.error('Exception:', error);
      this.error('Stack:', error.stack);
      this.scheduleReconnection(type);
    }
  }

  /**
   * Close an SSE connection
   * @param {string} type - 'production' or 'test'
   */
  closeSSE(type) {
    const sse = type === 'production' ? this.productionSSE : this.testSSE;

    if (sse.eventSource) {
      this.log(`Closing ${type} SSE connection`);
      sse.eventSource.close();
      sse.eventSource = null;
    }

    sse.connected = false;
    sse.connectedAt = null;
    sse.createdAt = null;

    if (sse.reconnectTimer) {
      clearTimeout(sse.reconnectTimer);
      sse.reconnectTimer = null;
    }
  }

  /**
   * Start SSE health monitoring
   * Proactively reconnects SSE connections that have been up too long
   */
  startSSEHealthCheck() {
    // Clear any existing interval
    if (this._sseHealthCheckInterval) {
      clearInterval(this._sseHealthCheckInterval);
    }

    this.log('Starting SSE health monitoring...');
    this._sseHealthCheckInterval = setInterval(() => {
      this.checkSSEHealth('production');
      this.checkSSEHealth('test');
    }, CONFIG.SSE_HEALTH_CHECK_INTERVAL);
  }

  /**
   * Check health of a single SSE connection
   * Reconnects if connection has been up longer than SSE_MAX_AGE
   * @param {string} type - 'production' or 'test'
   */
  checkSSEHealth(type) {
    const sse = type === 'production' ? this.productionSSE : this.testSSE;

    // Check if EventSource exists
    if (!sse.eventSource || !sse.createdAt) {
      this.log(`${type} SSE health check: no eventSource`);
      return;
    }

    const now = Date.now();
    const connectionAge = now - sse.createdAt;
    const ageMinutes = Math.round(connectionAge / 60000);

    // VMA server closes connections after 5 minutes - reconnect before that
    if (connectionAge > CONFIG.SSE_MAX_AGE) {
      this.log(`${type} SSE connection is ${ageMinutes} minutes old, reconnecting...`);
      this.closeSSE(type);
      this.setupSSE(type);
    } else {
      this.log(`${type} SSE health check: connection age ${ageMinutes} minutes (healthy)`);
    }
  }

  /**
   * Schedule SSE reconnection with exponential backoff
   * @param {string} type - 'production' or 'test'
   */
  scheduleReconnection(type) {
    const sse = type === 'production' ? this.productionSSE : this.testSSE;

    if (sse.reconnectTimer) {
      return; // Already scheduled
    }

    sse.retryCount = Math.min(sse.retryCount + 1, 10);
    const delay = Math.min(
      CONFIG.SSE_RECONNECT_DELAY * (2 ** (sse.retryCount - 1)),
      CONFIG.MAX_BACKOFF_DELAY,
    );

    this.log(`Scheduling ${type} SSE reconnection in ${delay}ms (attempt ${sse.retryCount})`);

    sse.reconnectTimer = setTimeout(() => {
      sse.reconnectTimer = null;

      // Check if this endpoint is still needed before reconnecting
      const needs = this.getDeviceEndpointNeeds();
      if ((type === 'production' && needs.hasProduction) || (type === 'test' && needs.hasTest)) {
        this.setupSSE(type);
      } else {
        this.log(`${type} SSE no longer needed, skipping reconnection`);
      }
    }, delay);
  }

  /**
   * Debounced wrapper for fetchAndDistributeAlerts
   * Delays execution to prevent rapid-fire fetches from multiple SSE messages
   */
  debouncedFetchAndDistributeAlerts() {
    // Clear any pending fetch
    if (this._fetchDebounceTimer) {
      this.log('Debouncing fetch request (canceling previous pending fetch)');
      clearTimeout(this._fetchDebounceTimer);
    }

    // Schedule new fetch
    this._fetchDebounceTimer = setTimeout(() => {
      this._fetchDebounceTimer = null;
      this.fetchAndDistributeAlerts().catch((err) => {
        this.error('Debounced fetchAndDistributeAlerts failed:', err);
      });
    }, CONFIG.FETCH_DEBOUNCE_DELAY);
  }

  /**
   * Fetch alerts from a specific endpoint
   * @param {string} type - 'production' or 'test'
   * @returns {Promise<Object>} Object with type and alerts array
   */
  async fetchAlertsFromEndpoint(type) {
    const baseUrl = type === 'production' ? CONFIG.API_URL : CONFIG.TEST_API_URL;

    this.log(`Fetching all alerts from ${type} endpoint:`, baseUrl);

    try {
      const response = await axios.get(baseUrl, {
        timeout: CONFIG.REQUEST_TIMEOUT,
        headers: {
          'User-Agent': 'Homey Hesa Fredrik (https://apps.athom.com/app/se.tstorm.hesafredrik)',
          Accept: 'application/json',
        },
      });

      const json = response.data;
      const alertCount = json.alerts ? json.alerts.length : 0;
      this.log(`Received ${alertCount} alerts from ${type} endpoint`);

      return { type, alerts: json.alerts || [] };
    } catch (error) {
      this.error(`=== Error fetching from ${type} endpoint ===`);
      this.error('Error:', error.message);
      if (error.response) {
        this.error('Response status:', error.response.status);
        const dataStr = JSON.stringify(error.response.data);
        this.error('Response data:', dataStr.substring(0, 200));
      }
      return { type, alerts: [] };
    }
  }

  /**
   * Fetch all alerts and distribute to relevant devices
   */
  async fetchAndDistributeAlerts() {
    // Prevent concurrent executions
    if (this._fetchInProgress) {
      this.log('Fetch already in progress, skipping duplicate call');
      return;
    }

    // Circuit breaker check
    if (this._apiCircuitOpen) {
      this.log('API circuit breaker open, skipping fetch');
      return;
    }

    this._fetchInProgress = true;

    try {
      const needs = this.getDeviceEndpointNeeds();

      // Fetch alerts from both endpoints concurrently if needed
      const fetchPromises = [];
      if (needs.hasProduction) {
        fetchPromises.push(this.fetchAlertsFromEndpoint('production'));
      }
      if (needs.hasTest) {
        fetchPromises.push(this.fetchAlertsFromEndpoint('test'));
      }

      const results = await Promise.all(fetchPromises);

      // Separate production and test alerts
      const productionAlerts = results.find((r) => r.type === 'production')?.alerts || [];
      const testAlerts = results.find((r) => r.type === 'test')?.alerts || [];

      this.log(`Production alerts: ${productionAlerts.length}, Test alerts: ${testAlerts.length}`);

      // Reset failure count on successful fetch
      this._apiFailureCount = 0;

      // Get all VMA devices
      let driver;
      let devices;
      try {
        driver = this.homey.drivers.getDriver('vma');
        devices = driver.getDevices();
      } catch (error) {
        this.error('Failed to get VMA driver or devices:', error);
        return;
      }

      if (devices.length === 0) {
        this.log('No VMA devices configured, skipping alert distribution');
        return;
      }

      // Distribute alerts to devices
      for (const device of devices) {
        try {
          // Skip devices that are turned off
          if (!device.hasCapability('onoff')) {
            this.log(`Device ${device.getName()} missing onoff capability, skipping`);
            continue;
          }
          const onoff = await device.getCapabilityValue('onoff');
          if (!onoff) {
            continue;
          }

          const deviceAreaCode = device.getData().id;
          const settings = device.getSettings();
          const deviceTestMode = settings.test_mode === true;

          // Select the correct alert source based on device test mode
          const alertSource = deviceTestMode ? testAlerts : productionAlerts;

          // Filter alerts for this device's area
          let relevantAlerts;

          // Special case: geocode "00" receives ALL alerts (nationwide)
          if (deviceAreaCode === '00') {
            relevantAlerts = alertSource;
          } else {
            relevantAlerts = alertSource.filter((alert) => {
              // Match exact area code or check if alert applies to this area
              // The API may return alerts for parent regions (e.g., county alerts for municipalities)
              if (!alert.info || !Array.isArray(alert.info)) return false;

              return alert.info.some((info) => {
                if (!info.area || !Array.isArray(info.area)) return false;

                return info.area.some((area) => {
                  // Check if the geocode matches exactly or if this is a county-wide alert
                  // and the device is in that county (first 2 digits match)
                  const alertGeocode = area.geocode;
                  if (!alertGeocode) return false;

                  // Exact match
                  if (alertGeocode === deviceAreaCode) return true;

                  // County-wide alert (2 digits) matches municipality (4 digits, first 2 match)
                  if (alertGeocode.length === 2 && deviceAreaCode.length === 4) {
                    return deviceAreaCode.startsWith(alertGeocode);
                  }

                  return false;
                });
              });
            });
          }

          this.log(`Device ${device.getName()} (${deviceAreaCode}, test=${deviceTestMode}): ${relevantAlerts.length} relevant alerts`);

          // Let the device process its relevant alerts
          await device.processAlerts(relevantAlerts);

        } catch (error) {
          this.error(`Error processing alerts for device ${device.getName()}:`, error);
        }
      }

    } catch (error) {
      this.error('=== Error in fetchAndDistributeAlerts ===');
      this.error('Error:', error.message);

      // Circuit breaker: track failures and open circuit after threshold
      this._apiFailureCount++;
      if (this._apiFailureCount >= 5) {
        this._apiCircuitOpen = true;
        this.log('Opening circuit breaker after 5 failures');
        setTimeout(() => {
          this._apiCircuitOpen = false;
          this._apiFailureCount = 0;
          this.log('Circuit breaker reset');
        }, 300000); // 5 minutes
      }
    } finally {
      this._fetchInProgress = false;
    }
  }

  /**
   * Called when app is being destroyed
   */
  async onUninit() {
    this.log('Hesa Fredrik is being destroyed');

    // Clear pending debounced fetch
    if (this._fetchDebounceTimer) {
      clearTimeout(this._fetchDebounceTimer);
      this._fetchDebounceTimer = null;
    }

    // Stop SSE health monitoring
    if (this._sseHealthCheckInterval) {
      clearInterval(this._sseHealthCheckInterval);
      this._sseHealthCheckInterval = null;
    }

    // Clean up both SSE connections
    this.closeSSE('production');
    this.closeSSE('test');
  }

}

module.exports = HesaFredrikApp;
