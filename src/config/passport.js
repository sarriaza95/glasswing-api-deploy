const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      const user = {
        provider: 'google',
        id: profile.id,
        displayName: profile.displayName,
        firstName: profile.name?.givenName || '',
        lastName: profile.name?.familyName || '',
        email: profile.emails?.[0]?.value || null,
        photo: profile.photos?.[0]?.value || null,
      };

      return done(null, user);
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

module.exports = passport;
