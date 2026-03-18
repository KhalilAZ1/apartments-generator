/**
 * Load German cities with zip codes and cold rent per m².
 * Used to generate approximate rent for listing info uploaded to Drive.
 */

import * as fs from "fs";
import * as path from "path";

export interface ZipRent {
  code: string;
  rentPerSqm: number;
}

export interface CityRent {
  name: string;
  zips: ZipRent[];
}

export interface GermanCitiesRentData {
  cities: CityRent[];
}

let cached: GermanCitiesRentData | null = null;

const DATA_PATH = path.join(__dirname, "german-cities-rent.json");

export function loadGermanCitiesRent(): GermanCitiesRentData {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf-8");
    const data = JSON.parse(raw) as GermanCitiesRentData;
    if (!data.cities || !Array.isArray(data.cities)) {
      throw new Error("Invalid format: expected { cities: [...] }");
    }
    cached = data;
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load german-cities-rent.json: ${msg}`);
  }
}

/**
 * Pick a random city and a random zip within it. Returns city name, zip code, and rent per m².
 */
export function pickRandomCityAndZip(): { cityName: string; zipCode: string; rentPerSqm: number } {
  const data = loadGermanCitiesRent();
  const city = data.cities[Math.floor(Math.random() * data.cities.length)];
  const zip = city.zips[Math.floor(Math.random() * city.zips.length)];
  return {
    cityName: city.name,
    zipCode: zip.code,
    rentPerSqm: zip.rentPerSqm,
  };
}
