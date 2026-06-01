import { useMemo } from 'react'

/**
 * Parse the iframe URL query string into the parameters the portal injects
 * via appConfig.properties. The portal substitutes {ItemIdDA},
 * {TimeStartUTC}, {TimeEndUTC} at navigation time, so the iframe sees a
 * normal query string.
 *
 * Also supports ?debug=1 for development/testing — bypasses the OData
 * call and loads static sample data instead.
 */
export function useUrlParams() {
  return useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return {
      id: params.get('id'),
      startTime: params.get('startTime'),
      endTime: params.get('endTime'),
      debug: params.get('debug') === '1',
    }
  }, [])
}
